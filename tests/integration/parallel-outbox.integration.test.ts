import 'reflect-metadata';
import 'dotenv/config';

import {
  beforeAll,
  afterAll,
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
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';

import { AppModule } from '../../src/app.module.js';

// ==================================================
// CONFIGURACOES
// ==================================================

const EXPECTED_WALLETS = 15;
const EXPECTED_EVENTS = EXPECTED_WALLETS * 2;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

let app: INestApplication | undefined;
let sqs: SQSClient | undefined;
let em: EntityManager;

let baseUrl = '';
let eventsQueueUrl = '';

let originalEventsQueueUrl: string | undefined;

const publishers: Array<
  ReturnType<typeof Bun.spawn>
> = [];

// ==================================================
// TIPOS
// ==================================================

interface OutboxRow {
  id: string;
  aggregate_id: string;
  published_at: Date | null;
}

interface TestWallet {
  id: string;
}

// ==================================================
// HELPERS
// ==================================================

async function createWallet(): Promise<TestWallet> {
  const response = await fetch(
    `${baseUrl}/wallets`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        playerId: randomUUID(),
        initialBalance: {
          amount: '100.00',
          currency: 'BRL',
        },
      }),
      signal: AbortSignal.timeout(30000),
    },
  );

  const body = await response.text();

  if (response.status !== 201) {
    throw new Error(
      `CREATE_WALLET_FAILED: ${response.status}: ${body}`,
    );
  }

  return JSON.parse(body) as TestWallet;
}

async function findOutboxRows(
  walletIds: string[],
): Promise<OutboxRow[]> {
  if (walletIds.length === 0) {
    return [];
  }

  const placeholders =
    walletIds.map(() => '?').join(', ');

  return em.fork().execute<OutboxRow[]>(
    `
    SELECT
      id::text AS id,
      aggregate_id::text AS aggregate_id,
      published_at
    FROM outbox_messages
    WHERE aggregate_id IN (${placeholders})
    ORDER BY occurred_at, id
    `,
    walletIds,
  );
}

async function waitUntilPublished(
  walletIds: string[],
  expectedCount: number,
): Promise<OutboxRow[]> {
  const deadline = Date.now() + 90000;

  while (Date.now() < deadline) {
    const rows = await findOutboxRows(walletIds);

    const published = rows.filter(
      (row) => row.published_at !== null,
    );

    if (
      rows.length === expectedCount &&
      published.length === expectedCount
    ) {
      return rows;
    }

    await sleep(300);
  }

  const rows = await findOutboxRows(walletIds);

  throw new Error(
    `OUTBOX_TIMEOUT: total=${rows.length}, ` +
    `published=${rows.filter(
      (row) => row.published_at !== null,
    ).length}, expected=${expectedCount}`,
  );
}

function startPublisher(): void {
  const worker = Bun.spawn(
    [
      process.execPath,
      'scripts/run-outbox-publisher.ts',
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL!,
        SQS_EVENTS_QUEUE_URL: eventsQueueUrl,
      },
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );

  publishers.push(worker);

  console.log(
    `Outbox Publisher iniciado. PID=${worker.pid}`,
  );
}

async function readEventIds(
  expectedIds: Set<string>,
): Promise<Set<string>> {
  if (!sqs) {
    throw new Error('SQS_NOT_INITIALIZED');
  }

  const received = new Set<string>();

  const deadline = Date.now() + 90000;

  while (
    received.size < expectedIds.size &&
    Date.now() < deadline
  ) {
    const result = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: eventsQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 2,
        VisibilityTimeout: 15,
      }),
    );

    for (const message of result.Messages ?? []) {
      if (!message.Body) {
        throw new Error('EVENT_WITHOUT_BODY');
      }

      const envelope = JSON.parse(
        message.Body,
      ) as {
        eventId?: unknown;
      };

      if (typeof envelope.eventId !== 'string') {
        throw new Error(
          'EVENT_WITHOUT_EVENT_ID',
        );
      }

      if (!expectedIds.has(envelope.eventId)) {
        throw new Error(
          `UNEXPECTED_EVENT_ID: ${envelope.eventId}`,
        );
      }

      received.add(envelope.eventId);

      if (message.ReceiptHandle) {
        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: eventsQueueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );
      }
    }
  }

  return received;
}

// ==================================================
// TESTE
// ==================================================

describe('Outbox - dois publishers concorrentes', () => {
  beforeAll(async () => {
    const dbUrl = process.env.DATABASE_URL;

    if (
      !dbUrl ||
      new URL(dbUrl).pathname !==
        '/backend_challenge_workers_test'
    ) {
      throw new Error(
        'WORKER_TEST_REQUIRES_ISOLATED_DATABASE',
      );
    }

    const endpoint =
      process.env.SQS_ENDPOINT ??
      'http://127.0.0.1:4566';

    const hostname = new URL(endpoint).hostname;

    if (
      hostname !== 'localhost' &&
      hostname !== '127.0.0.1'
    ) {
      throw new Error(
        'WORKER_TEST_REQUIRES_LOCALSTACK_ON_LOCALHOST',
      );
    }

    sqs = new SQSClient({
      region: process.env.SQS_REGION ?? 'us-east-1',
      endpoint,
      credentials: {
        accessKeyId: 'test',
        secretAccessKey: 'test',
      },
    });

    // Fila FIFO exclusiva para esta execucao.
    const suffix = randomUUID()
      .replaceAll('-', '')
      .slice(0, 16);

    const queue = await sqs.send(
      new CreateQueueCommand({
        QueueName:
          `outbox-concurrency-${suffix}.fifo`,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'true',
        },
      }),
    );

    if (!queue.QueueUrl) {
      throw new Error('TEST_EVENTS_QUEUE_NOT_CREATED');
    }

    eventsQueueUrl = queue.QueueUrl;

    originalEventsQueueUrl =
      process.env.SQS_EVENTS_QUEUE_URL;

    process.env.SQS_EVENTS_QUEUE_URL =
      eventsQueueUrl;

    // A API criara eventos na Outbox.
    // Os publishers serao processos separados.
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

    em = app.get(EntityManager);

  }, 45000);

  afterAll(async () => {
    // Encerrar apenas os workers iniciados
    // por este teste.
    for (const worker of publishers) {
      worker.kill();
    }

    await Promise.allSettled(
      publishers.map((worker) => worker.exited),
    );

    if (app) {
      await app.close();
    }

    if (sqs) {
      try {
        if (eventsQueueUrl) {
          await sqs.send(
            new DeleteQueueCommand({
              QueueUrl: eventsQueueUrl,
            }),
          );
        }
      } finally {
        sqs.destroy();
      }
    }

    if (originalEventsQueueUrl === undefined) {
      delete process.env.SQS_EVENTS_QUEUE_URL;
    } else {
      process.env.SQS_EVENTS_QUEUE_URL =
        originalEventsQueueUrl;
    }
  }, 30000);

  test(
    'dois publishers publicam todos os eventos',
    async () => {
      // --------------------------------------------
      // 1. Criar as wallets e seus eventos.
      // --------------------------------------------

      const wallets: TestWallet[] = [];

      for (let i = 0; i < EXPECTED_WALLETS; i++) {
        wallets.push(await createWallet());
      }

      const walletIds = wallets.map(
        (wallet) => wallet.id,
      );

      const before = await findOutboxRows(walletIds);

      expect(before.length)
        .toBe(EXPECTED_EVENTS);

      expect(
        before.every(
          (row) => row.published_at === null,
        ),
      ).toBe(true);

      const expectedIds = new Set(
        before.map((row) => row.id),
      );

      expect(expectedIds.size)
        .toBe(EXPECTED_EVENTS);

      // --------------------------------------------
      // 2. Iniciar dois processos independentes.
      // --------------------------------------------

      startPublisher();
      startPublisher();

      expect(publishers.length).toBe(2);

      expect(publishers[0]?.pid).not.toBe(
        publishers[1]?.pid,
      );

      // --------------------------------------------
      // 3. Verificar confirmacao no PostgreSQL.
      // --------------------------------------------

      const published = await waitUntilPublished(
        walletIds,
        EXPECTED_EVENTS,
      );

      expect(published.length)
        .toBe(EXPECTED_EVENTS);

      expect(
        published.every(
          (row) => row.published_at !== null,
        ),
      ).toBe(true);

      // --------------------------------------------
      // 4. Verificar os eventos recebidos no SQS.
      // --------------------------------------------

      const receivedIds =
        await readEventIds(expectedIds);

      expect(receivedIds.size)
        .toBe(EXPECTED_EVENTS);

      for (const id of expectedIds) {
        expect(receivedIds.has(id)).toBe(true);
      }

      console.log(
        'PASSOU: dois publishers iniciados.',
      );

      console.log(
        `PASSOU: ${EXPECTED_EVENTS} eventos publicados.`,
      );

      console.log(
        `PASSOU: ${EXPECTED_EVENTS} eventIds encontrados no SQS.`,
      );

      console.log(
        'PASSOU: nenhum evento esperado foi perdido.',
      );
    },
    180000,
  );
});