import 'dotenv/config';

import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';

import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';

import { Money } from
  '../../domain/value-objects/money.js';

import {
  WAGER_MESSAGE_HANDLER,
  type WagerMessageHandler,
  type WagerTransactionRequested,
  type ExternalWagerKind,
} from '../../application/ports/wager-message-handler.js';

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

  constructor(
    @Inject(WAGER_MESSAGE_HANDLER)
    private readonly handler: WagerMessageHandler,
  ) {
    const queueUrl = process.env.SQS_WAGER_QUEUE_URL;

    if (!queueUrl) {
      throw new Error('SQS_WAGER_QUEUE_URL_NOT_CONFIGURED');
    }

    this.queueUrl = queueUrl;

    this.sqs = new SQSClient({
      endpoint: process.env.SQS_ENDPOINT,
      region: process.env.SQS_REGION ?? 'us-east-1',
      credentials: {
        accessKeyId:
          process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey:
          process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
  }

  // Executa uma consulta à fila.
  async pollOnce(): Promise<void> {
    const response = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 10,
        VisibilityTimeout: 120,
        MessageSystemAttributeNames: [
          'ApproximateReceiveCount',
          'MessageGroupId',
        ],
      }),
    );

    for (const message of response.Messages ?? []) {
      if (!message.Body || !message.ReceiptHandle) {
        this.logger.error(
          'SQS_MESSAGE_WITHOUT_BODY_OR_RECEIPT',
        );
        continue;
      }

      try {
        const request = parseWagerMessage(message.Body);

        // O grupo FIFO deve corresponder à wallet.
        if (
          message.Attributes?.MessageGroupId !==
          request.data.walletId
        ) {
          throw new Error('INVALID_MESSAGE_GROUP');
        }

        // Aqui ocorrerá o processamento financeiro.
        // O handler precisa confirmar Inbox, saldo,
        // ledger, transação e Outbox no mesmo commit.
        await this.handler.handle(request);

        // ACK somente depois de o handler concluir.
        await this.sqs.send(
          new DeleteMessageCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );

        this.logger.log(
          JSON.stringify({
            action: 'sqs_message_acked',
            messageId: request.messageId,
            walletId: request.data.walletId,
          }),
        );
      } catch (error) {
        const reason =
          error instanceof Error
            ? error.message
            : 'UNKNOWN_ERROR';

        this.logger.warn(
          JSON.stringify({
            action: 'sqs_message_retry',
            sqsMessageId: message.MessageId,
            receiveCount:
              message.Attributes?.ApproximateReceiveCount,
            reason,
          }),
        );

        // Sem DeleteMessage:
        // após o visibility timeout, o SQS poderá
        // entregar novamente ou enviar à DLQ.
      }
    }
  }

  onModuleDestroy(): void {
    this.sqs.destroy();
  }
}
