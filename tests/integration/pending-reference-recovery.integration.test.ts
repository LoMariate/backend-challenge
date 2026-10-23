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

type WorkerKind = 'consumer' | 'pending-reference';
type WorkerProcess = ReturnType<typeof Bun.spawn>;
type WagerKind = 'BET' | 'WIN' | 'REFUND' | 'ROLLBACK';

type Worker = {
  label: string;
  child: WorkerProcess;
  logPath: string;
  errorPath: string;
};

type TestWallet = { id: string; playerId: string };
type TransactionRow = {
  id: string;
  status: string;
  reference_transaction_id: string | null;
  pending_reference_attempts: number | string;
};

type LedgerRow = {
  transaction_id: string;
  direction: string;
  amount: string;
};

type WalletResponse = {
  version: number;
  balance: { amount: string; currency: string };
};

type ReconciliationResponse = {
  consistent: boolean;
  checkedEntries: number;
  difference: { amount: string; currency: string };
};

const PROVIDER = 'pending-reference-recovery-test';
const VISIBILITY_SECONDS = 15;
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  endpoint: process.env.SQS_ENDPOINT,
  queue: process.env.SQS_WAGER_QUEUE_URL,
  visibility: process.env.SQS_WAGER_VISIBILITY_SECONDS,
  wait: process.env.SQS_WAGER_WAIT_SECONDS,
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  description: string,
  timeoutMs = 90000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(300);
  }
  throw new Error(`TIMEOUT: ${description}`);
}

async function startWorker(
  label: string,
  kind: WorkerKind,
): Promise<Worker> {
  const script = kind === 'consumer'
    ? 'scripts/run-wager-consumer.ts'
    : 'scripts/run-pending-reference-worker.ts';

  const logPath = join(logDir, `${label}.log`);
  const errorPath = join(logDir, `${label}.error.log`);
  await Bun.write(logPath, '');
  await Bun.write(errorPath, '');

  const child = Bun.spawn([process.execPath, script], {
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
      // Impede reutilizar o failpoint do teste anterior.
      WAGER_TEST_CRASH_AFTER_COMMIT_MESSAGE_ID: '',
    },
    stdout: Bun.file(logPath),
    stderr: Bun.file(errorPath),
  });

  const worker: Worker = { label, child, logPath, errorPath };
  workers.push(worker);

  if (kind === 'consumer') {
    await waitFor(async () => {
      const log = await Bun.file(logPath).text();
      if (log.includes('Wager SQS Consumer iniciado')) return true;
      if (child.exitCode !== null) {
        throw new Error(`${label} EXIT=${child.exitCode}: ` +
          await Bun.file(errorPath).text());
      }
      return false;
    }, `${label} nao iniciou`, 30000);
  } else {
    // O script de Pending Reference pode usar texto de log diferente.
    // A atividade real sera confirmada no PostgreSQL.
    await sleep(800);
    if (child.exitCode !== null) {
      throw new Error(`${label} EXIT=${child.exitCode}: ` +
        await Bun.file(errorPath).text());
    }
  }

  console.log(`${label} iniciado, PID=${child.pid}`);
  return worker;
}

async function stopWorker(worker: Worker): Promise<void> {
  if (worker.child.exitCode === null) {
    worker.child.kill('SIGTERM');
  }
  await Promise.race([
    worker.child.exited,
    sleep(10000).then(() => {
      if (worker.child.exitCode === null) worker.child.kill();
    }),
  ]);
  console.log(`${worker.label} encerrado`);
}

async function stopAllWorkers(): Promise<void> {
  await Promise.allSettled(workers.map(stopWorker));
}

async function acknowledged(messageId: string): Promise<boolean> {
  for (const worker of workers) {
    const text = await Bun.file(worker.logPath).text();
    if (
      text.includes('sqs_message_acked') &&
      text.split(/\r?\n/).some((line) =>
        line.includes('sqs_message_acked') && line.includes(messageId),
      )
    ) return true;
  }
  return false;
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
    throw new Error(`CREATE_WALLET HTTP ${response.status}: ${body}`);
  }
  return { id: (JSON.parse(body) as { id: string }).id, playerId };
}

function makeMessage(
  wallet: TestWallet,
  kind: WagerKind,
  amount: string,
  referenceExternalTransactionId?: string,
): WagerTransactionRequested {
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
      roundId: 'round-reference-recovery',
      gameId: 'game-reference-recovery',
      kind,
      money: { amount, currency: 'BRL' },
      ...(referenceExternalTransactionId
        ? { referenceExternalTransactionId }
        : {}),
    },
  };
}

async function sendMessage(message: WagerTransactionRequested): Promise<void> {
  if (!sqs) throw new Error('SQS_NOT_INITIALIZED');
  await sqs.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(message),
    MessageGroupId: message.data.walletId,
    MessageDeduplicationId: randomUUID(),
  }));
}

async function transactionRow(
  message: WagerTransactionRequested,
): Promise<TransactionRow | undefined> {
  const rows = await em.fork().execute<TransactionRow[]>(
    `SELECT
       id::text AS id,
       status,
       reference_transaction_id::text AS reference_transaction_id,
       pending_reference_attempts
     FROM wager_transactions
     WHERE provider_id = ? AND external_transaction_id = ?`,
    [message.data.providerId, message.data.externalTransactionId],
  );
  return rows[0];
}

async function waitForStatus(
  message: WagerTransactionRequested,
  status: string,
): Promise<TransactionRow> {
  await waitFor(async () => {
    const row = await transactionRow(message);
    return row?.status === status;
  }, `${message.data.kind} nao chegou a ${status}`, 120000);
  const row = await transactionRow(message);
  if (!row) throw new Error('TRANSACTION_DISAPPEARED');
  return row;
}

async function countSql(sql: string, params: unknown[]): Promise<number> {
  const rows = await em.fork().execute<{
    total: string | number;
  }[]>(sql, params);
  return Number(rows[0]?.total ?? 0);
}

async function ledgerRows(walletId: string): Promise<LedgerRow[]> {
  return em.fork().execute<LedgerRow[]>(
    `SELECT transaction_id::text AS transaction_id,
            direction, amount::text AS amount
     FROM wallet_ledger_entries
     WHERE wallet_id = ?`,
    [walletId],
  );
}

async function walletDetails(walletId: string): Promise<WalletResponse> {
  const response = await fetch(`${baseUrl}/wallets/${walletId}`);
  if (response.status !== 200) {
    throw new Error(`GET_WALLET_HTTP_${response.status}`);
  }
  return (await response.json()) as WalletResponse;
}

async function assertWallet(
  walletId: string,
  balance: string,
  version: number,
  entries: number,
): Promise<void> {
  const details = await walletDetails(walletId);
  expect(details.balance.amount).toBe(balance);
  expect(details.balance.currency).toBe('BRL');
  expect(details.version).toBe(version);
  expect((await ledgerRows(walletId)).length).toBe(entries);

  const response = await fetch(
    `${baseUrl}/wallets/${walletId}/reconciliation`,
    { method: 'POST' },
  );
  expect(response.status).toBe(200);
  const report = (await response.json()) as ReconciliationResponse;
  expect(report.consistent).toBe(true);
  expect(report.checkedEntries).toBe(entries);
  expect(report.difference.amount).toBe('0.00');
}

async function assertInbox(message: WagerTransactionRequested): Promise<void> {
  expect(await countSql(
    `SELECT COUNT(*) AS total FROM inbox_messages
     WHERE consumer_name = 'wager-transactions-consumer'
       AND message_id = ? AND processed_at IS NOT NULL`,
    [message.messageId],
  )).toBe(1);
}

async function assertOneLedgerEntry(
  transactionId: string,
  direction: 'DEBIT' | 'CREDIT',
  amount: string,
): Promise<void> {
  const rows = await em.fork().execute<LedgerRow[]>(
    `SELECT transaction_id::text AS transaction_id,
            direction, amount::text AS amount
     FROM wallet_ledger_entries
     WHERE transaction_id = ?`,
    [transactionId],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]?.direction).toBe(direction);
  expect(rows[0]?.amount).toBe(amount);
}

async function runOutOfOrderScenario(
  reversalKind: 'REFUND' | 'ROLLBACK',
  originalKind: 'BET' | 'WIN',
  amount: string,
  intermediateBalance: string,
  originalDirection: 'DEBIT' | 'CREDIT',
  reversalDirection: 'DEBIT' | 'CREDIT',
): Promise<void> {
  const wallet = await createWallet();
  const original = makeMessage(wallet, originalKind, amount);
  const reversal = makeMessage(
    wallet,
    reversalKind,
    amount,
    original.data.externalTransactionId,
  );

  // PASSO A: a reversao chega antes da referencia.
  await sendMessage(reversal);
  await waitFor(async () => acknowledged(reversal.messageId),
    `${reversalKind} sem ACK`, 45000);

  const pending = await waitForStatus(reversal, 'PENDING_REFERENCE');
  await assertInbox(reversal);
  await assertWallet(wallet.id, '100.00', 1, 1);
  expect(pending.reference_transaction_id).toBeNull();

  // O evento de referencia pendente foi persistido.
  expect(await countSql(
    `SELECT COUNT(*) AS total FROM outbox_messages
     WHERE aggregate_id = ?
       AND event_type = 'WagerTransactionPendingReference'`,
    [wallet.id],
  )).toBeGreaterThanOrEqual(1);

  // PASSO B: worker inicia, nao acha a referencia e agenda retry.
  const attemptsBefore = Number(pending.pending_reference_attempts);
  const firstWorker = await startWorker(
    `pending-${reversalKind.toLowerCase()}-primeiro`,
    'pending-reference',
  );

  await waitFor(async () => {
    const row = await transactionRow(reversal);
    return row?.status === 'PENDING_REFERENCE' &&
      Number(row.pending_reference_attempts) > attemptsBefore;
  }, `${reversalKind} nao agendou retry`, 120000);

  await stopWorker(firstWorker);
  expect((await transactionRow(reversal))?.status)
    .toBe('PENDING_REFERENCE');

  // PASSO C: a referencia chega enquanto o worker esta desligado.
  await sendMessage(original);
  await waitFor(async () => acknowledged(original.messageId),
    `${originalKind} sem ACK`, 45000);
  const processedOriginal = await waitForStatus(original, 'PROCESSED');
  await assertInbox(original);
  await assertWallet(wallet.id, intermediateBalance, 2, 2);

  // PASSO D: novo processo assume a pendencia e resolve.
  const secondWorker = await startWorker(
    `pending-${reversalKind.toLowerCase()}-reiniciado`,
    'pending-reference',
  );
  const processedReversal = await waitForStatus(reversal, 'PROCESSED');
  expect(processedReversal.id).toBe(pending.id);
  expect(processedReversal.reference_transaction_id)
    .toBe(processedOriginal.id);

  await assertWallet(wallet.id, '100.00', 3, 3);
  await assertOneLedgerEntry(
    processedOriginal.id,
    originalDirection,
    amount,
  );
  await assertOneLedgerEntry(
    processedReversal.id,
    reversalDirection,
    amount,
  );
  await assertInbox(reversal);
  await assertInbox(original);

  // PASSO E: uma nova reinicializacao nao reaplica a reversao.
  await stopWorker(secondWorker);
  const outboxCount = await countSql(
    'SELECT COUNT(*) AS total FROM outbox_messages WHERE aggregate_id = ?',
    [wallet.id],
  );

  const thirdWorker = await startWorker(
    `pending-${reversalKind.toLowerCase()}-verificacao`,
    'pending-reference',
  );
  await sleep(2500);
  await stopWorker(thirdWorker);

  await assertWallet(wallet.id, '100.00', 3, 3);
  expect((await transactionRow(reversal))?.status).toBe('PROCESSED');
  expect(await countSql(
    'SELECT COUNT(*) AS total FROM outbox_messages WHERE aggregate_id = ?',
    [wallet.id],
  )).toBe(outboxCount);

  console.log(`PASSOU: ${reversalKind} antes de ${originalKind}.`);
  console.log('PASSOU: worker reiniciado resolveu a referencia.');
  console.log('PASSOU: saldo 100.00, versao 3, ledger consistente.');
  console.log('PASSOU: novos restarts nao duplicaram movimentos.');
}

describe('Referencias fora de ordem + restart do worker', () => {
  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (
      !databaseUrl ||
      new URL(databaseUrl).pathname !== '/backend_challenge_workers_test'
    ) {
      throw new Error('WORKER_TEST_REQUIRES_ISOLATED_DATABASE');
    }

    endpoint = process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566';
    if (!['localhost', '127.0.0.1'].includes(new URL(endpoint).hostname)) {
      throw new Error('WORKER_TEST_REQUIRES_LOCALSTACK_ON_LOCALHOST');
    }

    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    logDir = join(process.cwd(), '.test-logs', `reference-recovery-${suffix}`);
    await mkdir(logDir, { recursive: true });

    sqs = new SQSClient({
      region: process.env.SQS_REGION ?? 'us-east-1',
      endpoint,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });

    const dlq = await sqs.send(new CreateQueueCommand({
      QueueName: `reference-it-dlq-${suffix}.fifo`,
      Attributes: { FifoQueue: 'true' },
    }));
    if (!dlq.QueueUrl) throw new Error('TEST_DLQ_CREATION_FAILED');
    dlqUrl = dlq.QueueUrl;

    const dlqAttrs = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: dlqUrl,
      AttributeNames: ['QueueArn'],
    }));
    const dlqArn = dlqAttrs.Attributes?.QueueArn;
    if (!dlqArn) throw new Error('TEST_DLQ_ARN_MISSING');

    const queue = await sqs.send(new CreateQueueCommand({
      QueueName: `reference-it-main-${suffix}.fifo`,
      Attributes: {
        FifoQueue: 'true',
        VisibilityTimeout: String(VISIBILITY_SECONDS),
        ReceiveMessageWaitTimeSeconds: '1',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: '5',
        }),
      },
    }));
    if (!queue.QueueUrl) throw new Error('TEST_QUEUE_CREATION_FAILED');
    queueUrl = queue.QueueUrl;

    // Configurar antes do NestFactory: o Consumer le o env no construtor.
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

    await startWorker('consumer-references', 'consumer');
  }, 45000);

  afterAll(async () => {
    await stopAllWorkers();
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

    restoreEnv('SQS_ENDPOINT', previousEnv.endpoint);
    restoreEnv('SQS_WAGER_QUEUE_URL', previousEnv.queue);
    restoreEnv('SQS_WAGER_VISIBILITY_SECONDS', previousEnv.visibility);
    restoreEnv('SQS_WAGER_WAIT_SECONDS', previousEnv.wait);

    if (logDir) console.log(`Logs: ${logDir}`);
  }, 30000);

  test('REFUND chega antes da BET e e resolvido apos restart', async () => {
    await runOutOfOrderScenario(
      'REFUND', 'BET', '30.00', '70.00', 'DEBIT', 'CREDIT',
    );
  }, 240000);

  test('ROLLBACK chega antes da WIN e e resolvido apos restart', async () => {
    await runOutOfOrderScenario(
      'ROLLBACK', 'WIN', '40.00', '140.00', 'CREDIT', 'DEBIT',
    );
  }, 240000);
});
