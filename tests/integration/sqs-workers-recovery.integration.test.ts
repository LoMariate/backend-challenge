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
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  SQSClient,
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { AppModule } from '../../src/app.module.js';
import type {
  WagerTransactionRequested,
} from '../../src/application/ports/wager-message-handler.js';

type WorkerProcess = ReturnType<typeof Bun.spawn>;

type Worker = {
  label: string;
  process: WorkerProcess;
  stdoutPath: string;
  stderrPath: string;
};

type TestWallet = { id: string; playerId: string };

type WalletResponse = {
  id: string;
  version: number;
  balance: { amount: string; currency: string };
};

type ReconciliationResponse = {
  consistent: boolean;
  checkedEntries: number;
  difference: { amount: string; currency: string };
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const PROVIDER = 'sqs-recovery-integration';
const WALLET_COUNT = 18;
const VISIBILITY_SECONDS = 4;

let app: INestApplication | undefined;
let em: EntityManager;
let sqs: SQSClient | undefined;
let queueUrl = '';
let dlqUrl = '';
let baseUrl = '';
let logDir = '';
let endpoint = '';

const workers: Worker[] = [];
const previousEnv = {
  queueUrl: process.env.SQS_WAGER_QUEUE_URL,
  visibility: process.env.SQS_WAGER_VISIBILITY_SECONDS,
  wait: process.env.SQS_WAGER_WAIT_SECONDS,
  endpoint: process.env.SQS_ENDPOINT,
};

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(200);
  }

  throw new Error(`${label}: TIMEOUT_AFTER_${timeoutMs}MS`);
}

async function logText(worker: Worker): Promise<string> {
  return Bun.file(worker.stdoutPath).text();
}

async function errorText(worker: Worker): Promise<string> {
  return Bun.file(worker.stderrPath).text();
}

async function wasAcked(worker: Worker, messageId: string): Promise<boolean> {
  const lines = (await logText(worker)).split(/\r?\n/);

  // O Logger do NestJS pode serializar o JSON interno como string.
  return lines.some(
    (line) =>
      line.includes('sqs_message_acked') && line.includes(messageId),
  );
}

async function ackedByAnyWorker(messageId: string): Promise<boolean> {
  for (const worker of workers) {
    if (await wasAcked(worker, messageId)) return true;
  }
  return false;
}

async function startWorker(
  label: string,
  crashAfterCommitMessageId?: string,
): Promise<Worker> {
  const stdoutPath = join(logDir, `${label}.log`);
  const stderrPath = join(logDir, `${label}.error.log`);

  await Bun.write(stdoutPath, '');
  await Bun.write(stderrPath, '');

  const child = Bun.spawn(
    [process.execPath, 'scripts/run-wager-consumer.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: process.env.DATABASE_URL!,
        SQS_ENDPOINT: endpoint,
        SQS_REGION: process.env.SQS_REGION ?? 'us-east-1',
        AWS_ACCESS_KEY_ID: 'test',
        AWS_SECRET_ACCESS_KEY: 'test',
        SQS_WAGER_QUEUE_URL: queueUrl,
        SQS_WAGER_VISIBILITY_SECONDS: String(VISIBILITY_SECONDS),
        SQS_WAGER_WAIT_SECONDS: '1',
        WAGER_TEST_CRASH_AFTER_COMMIT_MESSAGE_ID:
          crashAfterCommitMessageId ?? '',
      },
      stdout: Bun.file(stdoutPath),
      stderr: Bun.file(stderrPath),
    },
  );

  const worker: Worker = {
    label,
    process: child,
    stdoutPath,
    stderrPath,
  };
  workers.push(worker);

  await waitFor(
    async () => {
      const text = await logText(worker);
      if (text.includes('Wager SQS Consumer iniciado')) return true;
      if (child.exitCode !== null) {
        throw new Error(
          `${label}_EXITED_EARLY(${child.exitCode}): ${await errorText(worker)}`,
        );
      }
      return false;
    },
    30000,
    `${label}_DID_NOT_START`,
  );

  console.log(`Consumer ${label}: PID=${child.pid}`);
  return worker;
}

async function stopWorkers(): Promise<void> {
  const active = workers.splice(0, workers.length);

  for (const worker of active) {
    if (worker.process.exitCode === null) {
      worker.process.kill();
    }
  }

  await Promise.allSettled(active.map((w) => w.process.exited));
}

async function createWallet(): Promise<TestWallet> {
  const playerId = randomUUID();
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    }),
    signal: AbortSignal.timeout(30000),
  });

  const body = await response.text();
  if (response.status !== 201) {
    throw new Error(`CREATE_WALLET_HTTP_${response.status}: ${body}`);
  }

  const wallet = JSON.parse(body) as { id: string };
  return { id: wallet.id, playerId };
}

function makeBet(wallet: TestWallet): WagerTransactionRequested {
  const externalTransactionId = randomUUID();

  return {
    messageId: randomUUID(),
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: PROVIDER,
      externalTransactionId,
      idempotencyKey: `${PROVIDER}:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'sqs-recovery-round',
      gameId: 'sqs-recovery-game',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    },
  };
}

async function sendBet(message: WagerTransactionRequested): Promise<void> {
  if (!sqs) throw new Error('SQS_NOT_INITIALIZED');

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message),
      MessageGroupId: message.data.walletId,
      MessageDeduplicationId: randomUUID(),
    }),
  );
}

async function countSql(sql: string, params: unknown[]): Promise<number> {
  const rows = await em.fork().execute<
    { total: number | string }[]
  >(sql, params);
  return Number(rows[0]?.total ?? 0);
}

async function assertWalletConsistent(
  wallet: TestWallet,
  message: WagerTransactionRequested,
): Promise<void> {
  const response = await fetch(`${baseUrl}/wallets/${wallet.id}`);
  expect(response.status).toBe(200);
  const details = (await response.json()) as WalletResponse;

  expect(details.balance.amount).toBe('75.00');
  expect(details.version).toBe(2);

  const reconciliation = await fetch(
    `${baseUrl}/wallets/${wallet.id}/reconciliation`,
    { method: 'POST' },
  );
  expect(reconciliation.status).toBe(200);
  const report = (await reconciliation.json()) as ReconciliationResponse;
  expect(report.consistent).toBe(true);
  expect(report.checkedEntries).toBe(2);
  expect(report.difference.amount).toBe('0.00');

  const betTransactions = await countSql(
    `SELECT COUNT(*) AS total FROM wager_transactions
     WHERE provider_id = ? AND external_transaction_id = ?
       AND wallet_id = ? AND kind = 'BET' AND status = 'PROCESSED'`,
    [PROVIDER, message.data.externalTransactionId, wallet.id],
  );
  expect(betTransactions).toBe(1);

  const debits = await countSql(
    `SELECT COUNT(*) AS total FROM wallet_ledger_entries
     WHERE wallet_id = ? AND direction = 'DEBIT'
       AND amount = 25.00`,
    [wallet.id],
  );
  expect(debits).toBe(1);

  const inbox = await countSql(
    `SELECT COUNT(*) AS total FROM inbox_messages
     WHERE consumer_name = 'wager-transactions-consumer'
       AND message_id = ? AND processed_at IS NOT NULL`,
    [message.messageId],
  );
  expect(inbox).toBe(1);

  const outbox = await countSql(
    `SELECT COUNT(*) AS total FROM outbox_messages
     WHERE aggregate_id = ?`,
    [wallet.id],
  );
  expect(outbox).toBe(4); // 2 OPENING + 2 BET.
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe('3 SQS Consumers + crash apos commit antes do ACK', () => {
  beforeAll(async () => {
    const dbUrl = process.env.DATABASE_URL;
    if (
      !dbUrl ||
      new URL(dbUrl).pathname !== '/backend_challenge_workers_test'
    ) {
      throw new Error('WORKER_TEST_REQUIRES_ISOLATED_DATABASE');
    }

    endpoint = process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566';
    const endpointHost = new URL(endpoint).hostname;
    if (!['localhost', '127.0.0.1'].includes(endpointHost)) {
      throw new Error('WORKER_TEST_REQUIRES_LOCALSTACK_ON_LOCALHOST');
    }

    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    logDir = join(process.cwd(), '.test-logs', `sqs-recovery-${suffix}`);
    await mkdir(logDir, { recursive: true });

    sqs = new SQSClient({
      region: process.env.SQS_REGION ?? 'us-east-1',
      endpoint,
      credentials: {
        accessKeyId: 'test',
        secretAccessKey: 'test',
      },
    });

    const dlq = await sqs.send(
      new CreateQueueCommand({
        QueueName: `wager-consumer-it-dlq-${suffix}.fifo`,
        Attributes: { FifoQueue: 'true' },
      }),
    );
    if (!dlq.QueueUrl) throw new Error('TEST_DLQ_CREATION_FAILED');
    dlqUrl = dlq.QueueUrl;

    const attributes = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlqUrl,
        AttributeNames: ['QueueArn'],
      }),
    );
    const dlqArn = attributes.Attributes?.QueueArn;
    if (!dlqArn) throw new Error('TEST_DLQ_ARN_MISSING');

    const queue = await sqs.send(
      new CreateQueueCommand({
        QueueName: `wager-consumer-it-main-${suffix}.fifo`,
        Attributes: {
          FifoQueue: 'true',
          VisibilityTimeout: String(VISIBILITY_SECONDS),
          ReceiveMessageWaitTimeSeconds: '1',
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqArn,
            maxReceiveCount: '5',
          }),
        },
      }),
    );
    if (!queue.QueueUrl) throw new Error('TEST_QUEUE_CREATION_FAILED');
    queueUrl = queue.QueueUrl;

    process.env.SQS_ENDPOINT = endpoint;
    process.env.SQS_WAGER_QUEUE_URL = queueUrl;
    process.env.SQS_WAGER_VISIBILITY_SECONDS = String(VISIBILITY_SECONDS);
    process.env.SQS_WAGER_WAIT_SECONDS = '1';

    app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({
      whitelist: true,
      transform: true,
    }));
    await app.listen(0, '127.0.0.1');

    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    em = app.get(EntityManager);
  }, 45000);

  afterAll(async () => {
    await stopWorkers();
    if (app) await app.close();

    if (sqs) {
      try {
        if (queueUrl) {
          await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
        }
        if (dlqUrl) {
          await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
        }
      } finally {
        sqs.destroy();
      }
    }

    restoreEnv('SQS_WAGER_QUEUE_URL', previousEnv.queueUrl);
    restoreEnv('SQS_WAGER_VISIBILITY_SECONDS', previousEnv.visibility);
    restoreEnv('SQS_WAGER_WAIT_SECONDS', previousEnv.wait);
    restoreEnv('SQS_ENDPOINT', previousEnv.endpoint);

    if (logDir) console.log(`Logs dos workers: ${logDir}`);
  }, 30000);

  test('tres processos consomem wallets independentes', async () => {
    const first = await startWorker('consumer-a');
    const second = await startWorker('consumer-b');
    const third = await startWorker('consumer-c');

    expect(new Set([
      first.process.pid,
      second.process.pid,
      third.process.pid,
    ]).size).toBe(3);

    const wallets = await Promise.all(
      Array.from({ length: WALLET_COUNT }, () => createWallet()),
    );
    const messages = wallets.map(makeBet);

    await Promise.all(messages.map(sendBet));

    await waitFor(
      async () => {
        for (const message of messages) {
          if (!(await ackedByAnyWorker(message.messageId))) return false;
        }
        return true;
      },
      120000,
      'CONCURRENT_CONSUMERS_ACK_TIMEOUT',
    );

    for (let index = 0; index < wallets.length; index++) {
      await assertWalletConsistent(wallets[index]!, messages[index]!);
    }

    for (const worker of [first, second, third]) {
      const count = (await logText(worker))
        .split(/\r?\n/)
        .filter((line) => line.includes('sqs_message_acked')).length;
      console.log(`${worker.label} PID=${worker.process.pid}: ${count} ACKs`);
    }

    await stopWorkers();
    console.log(`PASSOU: ${WALLET_COUNT} mensagens, ${WALLET_COUNT} wallets consistentes.`);
  }, 180000);

  test('crash apos commit causa redelivery sem novo debito', async () => {
    // O teste anterior encerrou seus tres consumidores.
    const wallet = await createWallet();
    const message = makeBet(wallet);

    // Iniciar SOMENTE o consumer que ira morrer.
    const crashing = await startWorker('consumer-crash', message.messageId);
    await sendBet(message);

    const exitCode = await Promise.race([
      crashing.process.exited,
      sleep(45000).then(() => {
        throw new Error('EXPECTED_CRASH_DID_NOT_HAPPEN');
      }),
    ]);
    expect(exitCode).toBe(92);

    // A transacao financeira deve ja estar confirmada.
    await assertWalletConsistent(wallet, message);
    expect(await wasAcked(crashing, message.messageId)).toBe(false);

    // O ACK nao ocorreu. Apos expirar a visibilidade,
    // outros workers devem receber a mesma mensagem.
    const recoveryA = await startWorker('consumer-recovery-a');
    const recoveryB = await startWorker('consumer-recovery-b');
    expect(recoveryA.process.pid).not.toBe(recoveryB.process.pid);

    await waitFor(
      async () =>
        (await wasAcked(recoveryA, message.messageId)) ||
        (await wasAcked(recoveryB, message.messageId)),
      60000,
      'REDELIVERED_MESSAGE_WAS_NOT_ACKED',
    );

    await assertWalletConsistent(wallet, message);

    // A segunda entrega foi confirmada, mas o banco
    // continua com apenas 1 BET, 1 debito e 1 Inbox.
    console.log('PASSOU: worker saiu com codigo 92 apos o commit.');
    console.log('PASSOU: outro worker confirmou o ACK apos redelivery.');
    console.log('PASSOU: saldo 75.00, versao 2, ledger e Inbox sem duplicacao.');

    await stopWorkers();
  }, 120000);
});
