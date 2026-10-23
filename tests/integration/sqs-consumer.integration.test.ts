
import 'reflect-metadata';
import 'dotenv/config';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';

import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import {
  type INestApplication,
  ValidationPipe,
} from '@nestjs/common';

import { NestFactory } from '@nestjs/core';
import { EntityManager } from '@mikro-orm/postgresql';

import {
  SQSClient,
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';

import { AppModule } from '../../src/app.module.js';

import {
  WagerTransactionsConsumer,
} from '../../src/infrastructure/messaging/wager-transactions.consumer.js';

import {
  type ExternalWagerKind,
  type WagerTransactionRequested,
} from '../../src/application/ports/wager-message-handler.js';

// =====================================================
// CONFIGURAÇÕES E TIPOS
// =====================================================

interface TestWallet {
  id: string;
  playerId: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const providerId = 'integration-provider';

let app: INestApplication;
let sqs: SQSClient;
let consumer: WagerTransactionsConsumer;
let em: EntityManager;

let mainQueueUrl = '';
let dlqUrl = '';
let baseUrl = '';

// =====================================================
// FUNÇÕES AUXILIARES
// =====================================================

async function createWallet(): Promise<TestWallet> {
  const playerId = randomUUID();

  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      playerId,
      initialBalance: {
        amount: '100.00',
        currency: 'BRL',
      },
    }),
  });

  expect(response.status).toBe(201);

  const wallet = await response.json() as {
    id: string;
  };

  return {
    id: wallet.id,
    playerId,
  };
}

function makeMessage(
  wallet: TestWallet,
  kind: ExternalWagerKind,
  amount: string,
  referenceExternalTransactionId?: string,
): WagerTransactionRequested {
  const externalTransactionId = randomUUID();

  return {
    messageId: randomUUID(),
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId,
      externalTransactionId,
      idempotencyKey:
        `${providerId}:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'integration-round',
      gameId: 'integration-game',
      kind,
      money: {
        amount,
        currency: 'BRL',
      },
      ...(referenceExternalTransactionId
        ? { referenceExternalTransactionId }
        : {}),
    },
  };
}

async function sendMessage(
  message: WagerTransactionRequested,
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: mainQueueUrl,
      MessageBody: JSON.stringify(message),

      MessageGroupId: message.data.walletId,

      // DeduplicationId diferente em cada envio,
      // para testar a deduplicação real da Inbox.
      MessageDeduplicationId: randomUUID(),
    }),
  );
}

async function sendAndConsume(
  message: WagerTransactionRequested,
): Promise<void> {
  await sendMessage(message);

  await consumer.pollOnce();
}

async function walletBalance(
  walletId: string,
): Promise<{
  balance: string;
  version: number;
}> {
  const rows = await em.fork().execute<
    {
      balance: string;
      version: number;
    }[]
  >(
    `
    SELECT balance, version
    FROM wallets
    WHERE id = ?
    `,
    [walletId],
  );

  if (!rows[0]) {
    throw new Error('TEST_WALLET_NOT_FOUND');
  }

  return rows[0];
}

async function countRows(
  table:
    | 'wallet_ledger_entries'
    | 'wager_transactions'
    | 'outbox_messages',
  walletId: string,
): Promise<number> {
  const column =
    table === 'outbox_messages'
      ? 'aggregate_id'
      : 'wallet_id';

  const rows = await em.fork().execute<
    { total: string | number }[]
  >(
    `
    SELECT COUNT(*) AS total
    FROM ${table}
    WHERE ${column} = ?
    `,
    [walletId],
  );

  return Number(rows[0]?.total ?? 0);
}

async function inboxCount(
  messageId: string,
): Promise<number> {
  const rows = await em.fork().execute<
    { total: string | number }[]
  >(
    `
    SELECT COUNT(*) AS total
    FROM inbox_messages
    WHERE consumer_name = ?
      AND message_id = ?
    `,
    [
      'wager-transactions-consumer',
      messageId,
    ],
  );

  return Number(rows[0]?.total ?? 0);
}

// =====================================================
// TESTES DE INTEGRAÇÃO
// =====================================================

describe('SQS Consumer + Inbox', () => {

  // -------------------------------------------------
  // PREPARAÇÃO DO AMBIENTE
  // -------------------------------------------------

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;

    // Segurança: impedir testes no banco principal.
    if (
      !databaseUrl ||
      new URL(databaseUrl).pathname !==
        '/backend_challenge_test'
    ) {
      throw new Error(
        'INTEGRATION_TEST_REQUIRES_TEST_DATABASE',
      );
    }

    sqs = new SQSClient({
      region: process.env.SQS_REGION ?? 'us-east-1',
      endpoint:
        process.env.SQS_ENDPOINT ??
        'http://127.0.0.1:4566',
      credentials: {
        accessKeyId: 'test',
        secretAccessKey: 'test',
      },
    });

    // Criar nomes exclusivos para esta execução.
    const suffix = randomUUID()
      .replaceAll('-', '')
      .slice(0, 16);

    // Criar DLQ temporária.
    const dlq = await sqs.send(
      new CreateQueueCommand({
        QueueName: `wager-test-dlq-${suffix}.fifo`,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
        },
      }),
    );

    if (!dlq.QueueUrl) {
      throw new Error('TEST_DLQ_CREATION_FAILED');
    }

    dlqUrl = dlq.QueueUrl;

    const attributes = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlqUrl,
        AttributeNames: ['QueueArn'],
      }),
    );

    const dlqArn = attributes.Attributes?.QueueArn;

    if (!dlqArn) {
      throw new Error('TEST_DLQ_ARN_MISSING');
    }

    // Criar fila principal temporária.
    const mainQueue = await sqs.send(
      new CreateQueueCommand({
        QueueName: `wager-test-main-${suffix}.fifo`,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
          VisibilityTimeout: '2',
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqArn,
            maxReceiveCount: '3',
          }),
        },
      }),
    );

    if (!mainQueue.QueueUrl) {
      throw new Error('TEST_QUEUE_CREATION_FAILED');
    }

    mainQueueUrl = mainQueue.QueueUrl;

    // Direcionar o consumidor para a fila de teste.
    process.env.SQS_WAGER_QUEUE_URL = mainQueueUrl;
    process.env.SQS_WAGER_VISIBILITY_SECONDS = '2';
    process.env.SQS_WAGER_WAIT_SECONDS = '1';

    // Iniciar aplicação NestJS em porta aleatória.
    app = await NestFactory.create(
      AppModule,
      { logger: false },
    );

    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
      }),
    );

    await app.listen(0, '127.0.0.1');

    const address =
      app.getHttpServer().address() as AddressInfo;

    baseUrl = `http://127.0.0.1:${address.port}`;

    consumer = app.get(WagerTransactionsConsumer);
    em = app.get(EntityManager);

  }, 30000);

  // -------------------------------------------------
  // FINALIZAÇÃO
  // -------------------------------------------------

  afterAll(async () => {
    if (app) {
      await app.close();
    }

    if (sqs) {
      try {
        if (mainQueueUrl) {
          await sqs.send(
            new DeleteQueueCommand({
              QueueUrl: mainQueueUrl,
            }),
          );
        }

        if (dlqUrl) {
          await sqs.send(
            new DeleteQueueCommand({
              QueueUrl: dlqUrl,
            }),
          );
        }
      } finally {
        sqs.destroy();
      }
    }
  }, 30000);

  // =================================================
  // TESTE 1 — PROCESSAMENTO E IDEMPOTÊNCIA
  // =================================================

  test(
    'processa operações e impede duplicatas',
    async () => {
      const wallet = await createWallet();

      // BET: 100 -> 70
      const bet = makeMessage(
        wallet,
        'BET',
        '30.00',
      );

      await sendAndConsume(bet);

      expect(
        (await walletBalance(wallet.id)).balance,
      ).toBe('70.00');

      expect(
        await countRows(
          'wallet_ledger_entries',
          wallet.id,
        ),
      ).toBe(2);

      expect(
        await inboxCount(bet.messageId),
      ).toBe(1);

      // Repetir a mesma mensagem.
      await sendAndConsume(bet);

      expect(
        (await walletBalance(wallet.id)).balance,
      ).toBe('70.00');

      expect(
        await countRows(
          'wallet_ledger_entries',
          wallet.id,
        ),
      ).toBe(2);

      expect(
        await inboxCount(bet.messageId),
      ).toBe(1);

      // Mesmo negócio, novo messageId.
      await sendAndConsume({
        ...bet,
        messageId: randomUUID(),
      });

      expect(
        (await walletBalance(wallet.id)).balance,
      ).toBe('70.00');

      expect(
        await countRows(
          'wallet_ledger_entries',
          wallet.id,
        ),
      ).toBe(2);

      // WIN: 70 -> 120
      const win = makeMessage(
        wallet,
        'WIN',
        '50.00',
      );

      await sendAndConsume(win);

      expect(
        (await walletBalance(wallet.id)).balance,
      ).toBe('120.00');

      // LOSS: saldo permanece 120.
      const loss = makeMessage(
        wallet,
        'LOSS',
        '10.00',
      );

      await sendAndConsume(loss);

      expect(
        (await walletBalance(wallet.id)).balance,
      ).toBe('120.00');

      // REFUND: 120 -> 150
      const refund = makeMessage(
        wallet,
        'REFUND',
        '30.00',
        bet.data.externalTransactionId,
      );

      await sendAndConsume(refund);

      expect(
        (await walletBalance(wallet.id)).balance,
      ).toBe('150.00');

      // ROLLBACK do REFUND: 150 -> 120
      const rollback = makeMessage(
        wallet,
        'ROLLBACK',
        '30.00',
        refund.data.externalTransactionId,
      );

      await sendAndConsume(rollback);

      const finalWallet =
        await walletBalance(wallet.id);

      expect(finalWallet.balance).toBe('120.00');
      expect(finalWallet.version).toBe(5);

      // OPENING + BET + WIN + REFUND + ROLLBACK.
      expect(
        await countRows(
          'wallet_ledger_entries',
          wallet.id,
        ),
      ).toBe(5);

      // OPENING + BET + WIN + LOSS + REFUND + ROLLBACK.
      expect(
        await countRows(
          'wager_transactions',
          wallet.id,
        ),
      ).toBe(6);

      // OPENING: 2 eventos
      // BET: 2 eventos
      // WIN: 2 eventos
      // LOSS: 1 evento
      // REFUND: 2 eventos
      // ROLLBACK: 2 eventos
      expect(
        await countRows(
          'outbox_messages',
          wallet.id,
        ),
      ).toBe(11);

    },
    60000,
  );

  // =================================================
  // TESTE 2 — REJEIÇÃO FINANCEIRA
  // =================================================

  test(
    'persiste BET rejeitada e confirma a Inbox',
    async () => {
      const wallet = await createWallet();

      const bet = makeMessage(
        wallet,
        'BET',
        '150.00',
      );

      await sendAndConsume(bet);

      // Saldo e versão permanecem inalterados.
      const result = await walletBalance(wallet.id);

      expect(result.balance).toBe('100.00');
      expect(result.version).toBe(1);

      // Apenas o ledger da OPENING.
      expect(
        await countRows(
          'wallet_ledger_entries',
          wallet.id,
        ),
      ).toBe(1);

      // Conferir transação rejeitada.
      const transactions = await em.fork().execute<
        {
          status: string;
          failure_code: string | null;
        }[]
      >(
        `
        SELECT status, failure_code
        FROM wager_transactions
        WHERE provider_id = ?
          AND external_transaction_id = ?
        `,
        [
          bet.data.providerId,
          bet.data.externalTransactionId,
        ],
      );

      expect(
        transactions[0]?.status,
      ).toBe('REJECTED');

      expect(
        transactions[0]?.failure_code,
      ).toBe('INSUFFICIENT_FUNDS');

      // Conferir Inbox.
      const inbox = await em.fork().execute<
        { processed_at: Date | null }[]
      >(
        `
        SELECT processed_at
        FROM inbox_messages
        WHERE consumer_name = ?
          AND message_id = ?
        `,
        [
          'wager-transactions-consumer',
          bet.messageId,
        ],
      );

      expect(inbox).toHaveLength(1);
      expect(inbox[0]?.processed_at).toBeTruthy();

      // Conferir evento de rejeição.
      const events = await em.fork().execute<
        { total: string | number }[]
      >(
        `
        SELECT COUNT(*) AS total
        FROM outbox_messages
        WHERE aggregate_id = ?
          AND event_type = 'WagerTransactionRejected'
        `,
        [wallet.id],
      );

      expect(
        Number(events[0]?.total),
      ).toBe(1);

    },
    30000,
  );

  // =================================================
  // TESTE 3 — DEAD LETTER QUEUE
  // =================================================

  test(
    'encaminha mensagem inválida para a DLQ',
    async () => {
      const invalidBody = JSON.stringify({
        messageId: randomUUID(),
        type: 'INVALID_EVENT_TYPE',
      });

      await sqs.send(
        new SendMessageCommand({
          QueueUrl: mainQueueUrl,
          MessageBody: invalidBody,
          MessageGroupId: randomUUID(),
          MessageDeduplicationId: randomUUID(),
        }),
      );

      let foundInDlq = false;

      // Tentar consumir a mensagem inválida
      // até ela ser movida para a DLQ.
      for (let attempt = 0; attempt < 8; attempt++) {
        await consumer.pollOnce();

        await sleep(1100);

        const response = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: dlqUrl,
            WaitTimeSeconds: 1,
            MaxNumberOfMessages: 1,
          }),
        );

        if (
          response.Messages?.some(
            (message) => message.Body === invalidBody,
          )
        ) {
          foundInDlq = true;
          break;
        }
      }

      expect(foundInDlq).toBe(true);

    },
    60000,
  );

});
