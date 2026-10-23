import 'dotenv/config';

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';

import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  type Message,
} from '@aws-sdk/client-sqs';

import { Money } from
  '../../domain/value-objects/money.js';

import {
  WAGER_MESSAGE_HANDLER,
  type WagerMessageHandler,
  type WagerTransactionRequested,
  type ExternalWagerKind,
} from '../../application/ports/wager-message-handler.js';

import {
  wagerRetriesTotal,
} from '../observability/observability.metrics.js';

function isObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function requiredString(
  obj: Record<string, unknown>,
  key: string,
): string {
  const value = obj[key];

  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`INVALID_FIELD:${key}`);
  }

  return value;
}

export function parseWagerMessage(
  body: string,
): WagerTransactionRequested {
  const value: unknown = JSON.parse(body);

  if (!isObject(value)) {
    throw new Error('INVALID_MESSAGE');
  }

  if (value.type !== 'WagerTransactionRequested') {
    throw new Error('INVALID_MESSAGE_TYPE');
  }

  if (!isObject(value.data)) {
    throw new Error('INVALID_MESSAGE_DATA');
  }

  const data = value.data;

  const kind = requiredString(data, 'kind');

  const allowedKinds: ExternalWagerKind[] = [
    'BET',
    'WIN',
    'LOSS',
    'REFUND',
    'ROLLBACK',
  ];

  if (!allowedKinds.includes(kind as ExternalWagerKind)) {
    throw new Error('INVALID_TRANSACTION_KIND');
  }

  if (!isObject(data.money)) {
    throw new Error('INVALID_MONEY');
  }

  const money = Money.from({
    amount: requiredString(data.money, 'amount'),
    currency: requiredString(data.money, 'currency'),
  });

  if (!money.isPositive()) {
    throw new Error('INVALID_TRANSACTION_AMOUNT');
  }

  const occurredAt = requiredString(
    value,
    'occurredAt',
  );

  if (Number.isNaN(Date.parse(occurredAt))) {
    throw new Error('INVALID_OCCURRED_AT');
  }

  const reference = data.referenceExternalTransactionId;

  if (
    reference !== undefined &&
    (typeof reference !== 'string' || !reference.trim())
  ) {
    throw new Error('INVALID_REFERENCE');
  }

  if (
    (kind === 'REFUND' || kind === 'ROLLBACK') &&
    !reference
  ) {
    throw new Error('REFERENCE_REQUIRED');
  }

  return {
    messageId: requiredString(value, 'messageId'),
    type: 'WagerTransactionRequested',
    occurredAt,
    data: {
      providerId: requiredString(data, 'providerId'),
      externalTransactionId: requiredString(
        data,
        'externalTransactionId',
      ),
      idempotencyKey: requiredString(
        data,
        'idempotencyKey',
      ),
      playerId: requiredString(data, 'playerId'),
      walletId: requiredString(data, 'walletId'),
      roundId: requiredString(data, 'roundId'),
      gameId: requiredString(data, 'gameId'),
      kind: kind as ExternalWagerKind,
      money: money.toJSON(),
      ...(reference !== undefined
        ? { referenceExternalTransactionId: reference }
        : {}),
    },
  };
}

@Injectable()
export class WagerTransactionsConsumer
  implements OnModuleDestroy {

  private readonly logger = new Logger(
    WagerTransactionsConsumer.name,
  );

  private readonly sqs: SQSClient;
  private readonly queueUrl: string;

  private readonly visibilitySeconds: number;
  private readonly waitSeconds: number;

  constructor(
    @Inject(WAGER_MESSAGE_HANDLER)
    private readonly handler: WagerMessageHandler,
  ) {
    const queueUrl = process.env.SQS_WAGER_QUEUE_URL;

    if (!queueUrl) {
      throw new Error('SQS_WAGER_QUEUE_URL_NOT_CONFIGURED');
    }

    this.queueUrl = queueUrl;

    this.visibilitySeconds = Number(
      process.env.SQS_WAGER_VISIBILITY_SECONDS ?? '120',
    );

    this.waitSeconds = Number(
      process.env.SQS_WAGER_WAIT_SECONDS ?? '10',
    );

    if (
      !Number.isInteger(this.visibilitySeconds) ||
      this.visibilitySeconds < 1 ||
      this.visibilitySeconds > 43200
    ) {
      throw new Error('INVALID_SQS_VISIBILITY_SECONDS');
    }

    if (
      !Number.isInteger(this.waitSeconds) ||
      this.waitSeconds < 0 ||
      this.waitSeconds > 20
    ) {
      throw new Error('INVALID_SQS_WAIT_SECONDS');
    }

    this.sqs = new SQSClient({
      region: process.env.SQS_REGION ?? 'us-east-1',
      endpoint: process.env.SQS_ENDPOINT,
      credentials: {
        accessKeyId:
          process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey:
          process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
  }

  async pollOnce(): Promise<void> {
    const response = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: this.waitSeconds,
        VisibilityTimeout: this.visibilitySeconds,
        MessageSystemAttributeNames: [
          'ApproximateReceiveCount',
          'MessageGroupId',
        ],
      }),
    );

    for (const message of response.Messages ?? []) {
      await this.processMessage(message);
    }
  }

  private async processMessage(
    message: Message,
  ): Promise<void> {
    const receipt = message.ReceiptHandle;

    if (!receipt) {
      this.logger.error(
        'SQS_MESSAGE_WITHOUT_RECEIPT_HANDLE',
      );
      return;
    }

    if (!message.Body) {
      await this.handleFailure(
        message,
        new Error('SQS_MESSAGE_WITHOUT_BODY'),
        true,
      );
      return;
    }

    // 1. Validar a mensagem ANTES do processamento.
    let request: ReturnType<typeof parseWagerMessage>;

    try {
      request = parseWagerMessage(message.Body);

      if (
        message.Attributes?.MessageGroupId !==
        request.data.walletId
      ) {
        throw new Error('INVALID_MESSAGE_GROUP');
      }
    } catch (error) {
      // Payload inválido: não deve entrar no domínio.
      // Sem ACK; após o limite de recebimentos,
      // o SQS moverá a mensagem para a DLQ.
      await this.handleFailure(message, error, true);
      return;
    }

    // 2. Enquanto o processamento estiver ativo,
    // renovar a visibilidade periodicamente.
    const heartbeat = setInterval(() => {
      void this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: receipt,
          VisibilityTimeout: this.visibilitySeconds,
        }),
      ).catch((error: unknown) => {
        this.logger.warn(
          JSON.stringify({
            action: 'sqs_visibility_renewal_failed',
            messageId: request.messageId,
            reason: this.errorMessage(error),
          }),
        );
      });
    }, Math.max(
      1000,
      Math.floor(this.visibilitySeconds * 500),
    ));

    try {
      // 3. Executar transação financeira + Inbox
      // + Ledger + Outbox no PostgreSQL.
      await this.handler.handle(request);
    } catch (error) {
      clearInterval(heartbeat);

      const permanent =
        error instanceof BadRequestException ||
        error instanceof ConflictException;

      await this.handleFailure(
        message,
        error,
        permanent,
        request,
      );

      return;
    }

    clearInterval(heartbeat);
    // TESTE DE RECUPERACAO: falha controlada apos o commit.
    // Este bloco nao e ativado em operacao normal.

    if (
      process.env.NODE_ENV === 'test' &&
      process.env.WAGER_TEST_CRASH_AFTER_COMMIT_MESSAGE_ID ===
        request.messageId
    ) {
      const databaseUrl = process.env.DATABASE_URL;
      const sqsEndpoint = process.env.SQS_ENDPOINT;

      const allowedDatabase =
        databaseUrl !== undefined &&
        new URL(databaseUrl).pathname ===
          '/backend_challenge_workers_test';

      const allowedLocalStack =
        sqsEndpoint !== undefined &&
        ['localhost', '127.0.0.1'].includes(
          new URL(sqsEndpoint).hostname,
        );

      const allowedQueue =
        this.queueUrl.includes('wager-consumer-it-');

      if (
        !allowedDatabase ||
        !allowedLocalStack ||
        !allowedQueue
      ) {
        throw new Error(
          'CRASH_FAILPOINT_REQUIRES_ISOLATED_TEST_ENVIRONMENT',
        );
      }

      // Encerramento abrupto, proposital.
      // O ACK ainda nao aconteceu.
      process.exit(92);
    }
    // 4. ACK somente após o handler confirmar o commit.
    // Se DeleteMessage falhar, a mensagem poderá voltar.
    // A Inbox e a idempotência financeira protegerão
    // contra uma segunda movimentação.
    await this.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receipt,
      }),
    );

    this.logger.log(
      JSON.stringify({
        action: 'sqs_message_acked',
        correlationId: request.data.externalTransactionId,
        messageId: request.messageId,
        walletId: request.data.walletId,
        providerId: request.data.providerId,
      }),
    );
  }

  private async handleFailure(
    message: Message,
    error: unknown,
    permanent: boolean,
    request?: ReturnType<typeof parseWagerMessage>,
  ): Promise<void> {
    const receiveCount = Number(
      message.Attributes?.ApproximateReceiveCount ?? '1',
    );

    // Erro permanente: nova tentativa rápida até DLQ.
    // Erro transitório: backoff exponencial até 60s.
    const delaySeconds = permanent
      ? 1
      : Math.min(
          60,
          2 ** Math.min(receiveCount, 5),
        );

    this.logger.warn(
      JSON.stringify({
        action: permanent
          ? 'sqs_permanent_failure'
          : 'sqs_transient_failure',
        correlationId:
          request?.data.externalTransactionId,
        messageId:
          request?.messageId ?? message.MessageId,
        walletId: request?.data.walletId,
        providerId: request?.data.providerId,
        receiveCount,
        reason: this.errorMessage(error),
      }),
    );

    if (!message.ReceiptHandle) {
      return;
    }

    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: delaySeconds,
        }),
      );
      wagerRetriesTotal.inc({
      component: 'sqs_consumer',
    });
    } catch (visibilityError) {
      // Sem ACK. A mensagem voltará quando expirar
      // a visibilidade original, se a fila estiver
      // operacional.
      this.logger.error(
        JSON.stringify({
          action: 'sqs_retry_schedule_failed',
          sqsMessageId: message.MessageId,
          reason: this.errorMessage(visibilityError),
        }),
      );
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error
      ? error.message
      : 'UNKNOWN_ERROR';
  }

  onModuleDestroy(): void {
    this.sqs.destroy();
  }
}
