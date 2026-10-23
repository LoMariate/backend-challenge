import 'reflect-metadata';
import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
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
import { WagerTransactionsConsumer } from
  '../../src/infrastructure/messaging/wager-transactions.consumer.js';
import type { WagerTransactionRequested } from
  '../../src/application/ports/wager-message-handler.js';

type Wallet = { id: string; playerId: string };
type WagerRow = {
  id: string;
  status: string;
  failure_code: string | null;
  pending_reference_attempts: number | string;
};
type WalletRow = { balance: string; version: number };
type FailureStage = 'ledger' | 'outbox';

type Reconciliation = {
  consistent: boolean;
  checkedEntries: number;
  difference: { amount: string; currency: string };
};

const PROVIDER = 'atomicity-integration-provider';
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const triggerFunction = `it_atomicity_fault_${suffix}`;
const ledgerTrigger = `it_ledger_fault_${suffix}`;
const outboxTrigger = `it_outbox_fault_${suffix}`;

let app: INestApplication | undefined;
let sqs: SQSClient | undefined;
let em: EntityManager;
let consumer: WagerTransactionsConsumer;
let baseUrl = '';
let mainQueueUrl = '';
let dlqUrl = '';
let eventsQueueUrl = '';
let endpoint = '';
let worker: ReturnType<typeof Bun.spawn> | undefined;
let logDir = '';

const savedEnv = {
  SQS_ENDPOINT: process.env.SQS_ENDPOINT,
  SQS_WAGER_QUEUE_URL: process.env.SQS_WAGER_QUEUE_URL,
  SQS_WAGER_DLQ_URL: process.env.SQS_WAGER_DLQ_URL,
  SQS_EVENTS_QUEUE_URL: process.env.SQS_EVENTS_QUEUE_URL,
  SQS_WAGER_VISIBILITY_SECONDS: process.env.SQS_WAGER_VISIBILITY_SECONDS,
  SQS_WAGER_WAIT_SECONDS: process.env.SQS_WAGER_WAIT_SECONDS,
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function sql<T>(query: string, params: unknown[] = []): Promise<T[]> {
  return em.fork().execute<T[]>(query, params);
}

async function count(query: string, params: unknown[]): Promise<number> {
  const rows = await sql<{ total: string | number }>(query, params);
  return Number(rows[0]?.total ?? 0);
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  description: string,
  timeoutMs = 30000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(250);
  }
  throw new Error(`TIMEOUT: ${description}`);
}

async function makeWallet(): Promise<Wallet> {
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
  wallet: Wallet,
  kind: 'BET' | 'REFUND',
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
      roundId: 'atomicity-round',
      gameId: 'atomicity-game',
      kind,
      money: { amount, currency: 'BRL' },
      ...(referenceExternalTransactionId
        ? { referenceExternalTransactionId }
        : {}),
    },
  };
}

async function send(message: WagerTransactionRequested): Promise<void> {
  if (!sqs) throw new Error('SQS_NOT_INITIALIZED');
  await sqs.send(new SendMessageCommand({
    QueueUrl: mainQueueUrl,
    MessageBody: JSON.stringify(message),
    MessageGroupId: message.data.walletId,
    MessageDeduplicationId: randomUUID(),
  }));
}

async function wagerRow(
  message: WagerTransactionRequested,
): Promise<WagerRow | undefined> {
  const rows = await sql<WagerRow>(
    `SELECT id::text AS id, status, failure_code,
            pending_reference_attempts
       FROM wager_transactions
      WHERE provider_id = ? AND external_transaction_id = ?`,
    [message.data.providerId, message.data.externalTransactionId],
  );
  return rows[0];
}

async function walletRow(walletId: string): Promise<WalletRow> {
  const rows = await sql<WalletRow>(
    `SELECT balance::text AS balance, version
       FROM wallets WHERE id = ?`,
    [walletId],
  );
  if (!rows[0]) throw new Error('WALLET_NOT_FOUND');
  return rows[0];
}

async function ledgerCount(walletId: string): Promise<number> {
  return count(
    'SELECT COUNT(*) AS total FROM wallet_ledger_entries WHERE wallet_id = ?',
    [walletId],
  );
}

async function outboxCount(walletId: string): Promise<number> {
  return count(
    'SELECT COUNT(*) AS total FROM outbox_messages WHERE aggregate_id = ?',
    [walletId],
  );
}

async function inboxCount(messageId: string): Promise<number> {
  return count(
    `SELECT COUNT(*) AS total FROM inbox_messages
      WHERE consumer_name = 'wager-transactions-consumer'
        AND message_id = ?`,
    [messageId],
  );
}

async function processedInboxCount(messageId: string): Promise<number> {
  return count(
    `SELECT COUNT(*) AS total FROM inbox_messages
      WHERE consumer_name = 'wager-transactions-consumer'
        AND message_id = ? AND processed_at IS NOT NULL`,
    [messageId],
  );
}

async function assertWallet(
  walletId: string,
  balance: string,
  version: number,
  entries: number,
): Promise<void> {
  const actual = await walletRow(walletId);
  expect(actual.balance).toBe(balance);
  expect(Number(actual.version)).toBe(version);
  expect(await ledgerCount(walletId)).toBe(entries);

  const response = await fetch(
    `${baseUrl}/wallets/${walletId}/reconciliation`,
    { method: 'POST', signal: AbortSignal.timeout(30000) },
  );
  expect(response.status).toBe(200);
  const report = (await response.json()) as Reconciliation;
  expect(report.consistent).toBe(true);
  expect(report.difference.amount).toBe('0.00');
  expect(report.checkedEntries).toBe(entries);
}

// Cria um trigger temporario que provoca uma falha real de PostgreSQL
// apenas ao tentar gravar a wallet indicada, neste banco isolado.
async function createFaultFunction(): Promise<void> {
  await sql(`
    CREATE FUNCTION ${triggerFunction}() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_ARGV[1] = 'ledger' THEN
        IF NEW.wallet_id::text = TG_ARGV[0] THEN
          RAISE EXCEPTION 'IT_INJECTED_LEDGER_FAILURE';
        END IF;
      ELSIF TG_ARGV[1] = 'outbox' THEN
        IF NEW.aggregate_id::text = TG_ARGV[0] THEN
          RAISE EXCEPTION 'IT_INJECTED_OUTBOX_FAILURE';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$;
  `);
}

async function installFault(
  stage: FailureStage,
  walletId: string,
): Promise<void> {
  const table = stage === 'ledger'
    ? 'wallet_ledger_entries'
    : 'outbox_messages';
  const trigger = stage === 'ledger' ? ledgerTrigger : outboxTrigger;

  // walletId vem de UUID gerado pela propria aplicacao.
  if (!/^[0-9a-f-]{36}$/i.test(walletId)) {
    throw new Error('INVALID_TEST_WALLET_ID');
  }

  await sql(`
    CREATE TRIGGER ${trigger}
    BEFORE INSERT ON ${table}
    FOR EACH ROW EXECUTE FUNCTION
    ${triggerFunction}('${walletId}', '${stage}');
  `);
}

async function removeFault(stage: FailureStage): Promise<void> {
  const table = stage === 'ledger'
    ? 'wallet_ledger_entries'
    : 'outbox_messages';
  const trigger = stage === 'ledger' ? ledgerTrigger : outboxTrigger;
  await sql(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
}

async function runAtomicityScenario(stage: FailureStage): Promise<void> {
  const wallet = await makeWallet();
  const bet = makeMessage(wallet, 'BET', '30.00');
  expect(await outboxCount(wallet.id)).toBe(2); // OPENING

  await installFault(stage, wallet.id);
  try {
    await send(bet);
    // O Consumer captura a excecao de SQL, nao confirma o ACK
    // e agenda a reentrega com ChangeMessageVisibility.
    await consumer.pollOnce();

    // O rollback deve abranger TODAS as gravacoes desta BET.
    expect(await wagerRow(bet)).toBeUndefined();
    expect(await inboxCount(bet.messageId)).toBe(0);
    expect(await outboxCount(wallet.id)).toBe(2);
    await assertWallet(wallet.id, '100.00', 1, 1);
  } finally {
    await removeFault(stage);
  }

  // Depois de remover a falha, a mesma mensagem SQS e reentregue.
  await waitUntil(async () => {
    await consumer.pollOnce();
    return (await wagerRow(bet))?.status === 'PROCESSED';
  }, `BET apos ${stage} nao foi reprocessada`, 45000);

  const first = await wagerRow(bet);
  expect(first?.status).toBe('PROCESSED');
  expect(await inboxCount(bet.messageId)).toBe(1);
  expect(await processedInboxCount(bet.messageId)).toBe(1);
  expect(await outboxCount(wallet.id)).toBe(4); // OPENING + BET
  await assertWallet(wallet.id, '70.00', 2, 2);

  // Redelivery posterior: nenhuma gravacao adicional.
  await send(bet);
  await consumer.pollOnce();
  expect((await wagerRow(bet))?.id).toBe(first?.id);
  expect(await inboxCount(bet.messageId)).toBe(1);
  expect(await outboxCount(wallet.id)).toBe(4);
  await assertWallet(wallet.id, '70.00', 2, 2);

  console.log(`PASSOU: falha de ${stage} reverteu Inbox/Wallet/Ledger/Outbox.`);
  console.log('PASSOU: retry processou uma unica vez e reconciliou saldo.');
}

async function startPendingWorker(): Promise<void> {
  const stdoutPath = join(logDir, 'pending-worker.log');
  const stderrPath = join(logDir, 'pending-worker-error.log');
  await Bun.write(stdoutPath, '');
  await Bun.write(stderrPath, '');

  worker = Bun.spawn(
    [process.execPath, 'scripts/run-pending-reference-worker.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: process.env.DATABASE_URL!,
        WAGER_TEST_CRASH_AFTER_COMMIT_MESSAGE_ID: '',
      },
      stdout: Bun.file(stdoutPath),
      stderr: Bun.file(stderrPath),
    },
  );

  await sleep(800);
  if (worker.exitCode !== null) {
    throw new Error(
      `PENDING_WORKER_EXIT_${worker.exitCode}: ` +
      await Bun.file(stderrPath).text(),
    );
  }
  console.log(`Pending Reference Worker iniciado: PID=${worker.pid}`);
}

async function stopPendingWorker(): Promise<void> {
  if (!worker) return;
  if (worker.exitCode === null) worker.kill('SIGTERM');
  await Promise.race([
    worker.exited,
    sleep(10000).then(() => {
      if (worker?.exitCode === null) worker.kill();
    }),
  ]);
  worker = undefined;
}

async function runExpiredReferenceScenario(): Promise<void> {
  const wallet = await makeWallet();
  const missingReferenceId = randomUUID();
  const refund = makeMessage(wallet, 'REFUND', '30.00', missingReferenceId);

  await send(refund);
  await consumer.pollOnce();
  expect((await wagerRow(refund))?.status).toBe('PENDING_REFERENCE');
  expect(await inboxCount(refund.messageId)).toBe(1);
  expect(await processedInboxCount(refund.messageId)).toBe(1);
  expect(await outboxCount(wallet.id)).toBe(3); // OPENING + PENDING_REFERENCE
  await assertWallet(wallet.id, '100.00', 1, 1);

  await startPendingWorker();
  try {
    // Aceleramos apenas o relogio de agendamento do teste.
    // O worker continua executando sua logica real de retry,
    // com o limite de tentativas implementado na aplicacao.
    for (let iteration = 0; iteration < 16; iteration++) {
      const before = await wagerRow(refund);
      if (!before) throw new Error('PENDING_REFUND_DISAPPEARED');
      if (before.status === 'REJECTED') break;
      if (before.status !== 'PENDING_REFERENCE') {
        throw new Error(`UNEXPECTED_REFUND_STATUS_${before.status}`);
      }

      await sql(
        `UPDATE wager_transactions
            SET next_reference_attempt_at = NOW() - INTERVAL '1 second'
          WHERE id = ? AND status = 'PENDING_REFERENCE'`,
        [before.id],
      );

      await waitUntil(async () => {
        const after = await wagerRow(refund);
        if (!after) return false;
        return after.status !== 'PENDING_REFERENCE' ||
          Number(after.pending_reference_attempts) >
          Number(before.pending_reference_attempts);
      }, `retry pendente nao avancou (iteracao ${iteration})`, 20000);
    }
  } finally {
    await stopPendingWorker();
  }

  const final = await wagerRow(refund);
  expect(final?.status).toBe('REJECTED');
  expect(final?.failure_code).toMatch(/REFERENCE/i);
  expect(await inboxCount(refund.messageId)).toBe(1);
  expect(await processedInboxCount(refund.messageId)).toBe(1);
  expect(await count(
    `SELECT COUNT(*) AS total FROM wallet_ledger_entries
       WHERE transaction_id = ?`,
    [final!.id],
  )).toBe(0);
  expect(await count(
    `SELECT COUNT(*) AS total FROM outbox_messages
       WHERE aggregate_id = ?
         AND event_type = 'WagerTransactionRejected'`,
    [wallet.id],
  )).toBe(1);
  await assertWallet(wallet.id, '100.00', 1, 1);

  console.log('PASSOU: referencia ausente terminou em REJECTED.');
  console.log('PASSOU: failureCode registrado e evento de rejeicao gerado.');
  console.log('PASSOU: saldo/ledger nao sofreram movimentacoes.');
}

describe('Atomicidade financeira e falhas permanentes', () => {
  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL_REQUIRED');
    const parsedDb = new URL(databaseUrl);
    if (
      parsedDb.pathname !== '/backend_challenge_workers_test' ||
      !['localhost', '127.0.0.1'].includes(parsedDb.hostname)
    ) {
      throw new Error('TEST_REQUIRES_LOCAL_ISOLATED_POSTGRES_DATABASE');
    }

    endpoint = process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566';
    if (!['localhost', '127.0.0.1'].includes(new URL(endpoint).hostname)) {
      throw new Error('TEST_REQUIRES_LOCALSTACK_ON_LOCALHOST');
    }

    logDir = join(process.cwd(), '.test-logs', `atomicity-${suffix}`);
    await mkdir(logDir, { recursive: true });

    sqs = new SQSClient({
      region: process.env.SQS_REGION ?? 'us-east-1',
      endpoint,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });

    const dlq = await sqs.send(new CreateQueueCommand({
      QueueName: `atomicity-it-dlq-${suffix}.fifo`,
      Attributes: { FifoQueue: 'true' },
    }));
    if (!dlq.QueueUrl) throw new Error('TEST_DLQ_NOT_CREATED');
    dlqUrl = dlq.QueueUrl;

    const attributes = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: dlqUrl,
      AttributeNames: ['QueueArn'],
    }));
    const arn = attributes.Attributes?.QueueArn;
    if (!arn) throw new Error('TEST_DLQ_ARN_MISSING');

    const main = await sqs.send(new CreateQueueCommand({
      QueueName: `atomicity-it-main-${suffix}.fifo`,
      Attributes: {
        FifoQueue: 'true',
        VisibilityTimeout: '3',
        ReceiveMessageWaitTimeSeconds: '1',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: arn,
          maxReceiveCount: '5',
        }),
      },
    }));
    if (!main.QueueUrl) throw new Error('TEST_MAIN_QUEUE_NOT_CREATED');
    mainQueueUrl = main.QueueUrl;

    const events = await sqs.send(new CreateQueueCommand({
      QueueName: `atomicity-it-events-${suffix}.fifo`,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'true',
      },
    }));
    if (!events.QueueUrl) throw new Error('TEST_EVENTS_QUEUE_NOT_CREATED');
    eventsQueueUrl = events.QueueUrl;

    process.env.SQS_ENDPOINT = endpoint;
    process.env.SQS_WAGER_QUEUE_URL = mainQueueUrl;
    process.env.SQS_WAGER_DLQ_URL = dlqUrl;
    process.env.SQS_EVENTS_QUEUE_URL = eventsQueueUrl;
    process.env.SQS_WAGER_VISIBILITY_SECONDS = '3';
    process.env.SQS_WAGER_WAIT_SECONDS = '1';
    process.env.AWS_ACCESS_KEY_ID = 'test';
    process.env.AWS_SECRET_ACCESS_KEY = 'test';

    app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({
      whitelist: true,
      transform: true,
    }));
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    em = app.get(EntityManager);
    consumer = app.get(WagerTransactionsConsumer);

    await createFaultFunction();
  }, 45000);

  afterAll(async () => {
    await stopPendingWorker();

    if (em) {
      try {
        await removeFault('ledger');
        await removeFault('outbox');
        await sql(`DROP FUNCTION IF EXISTS ${triggerFunction}() CASCADE`);
      } catch (error) {
        console.error('Falha ao limpar triggers de teste:', error);
      }
    }
    if (app) await app.close();

    if (sqs) {
      try {
        for (const queueUrl of [mainQueueUrl, dlqUrl, eventsQueueUrl]) {
          if (queueUrl) {
            await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
          }
        }
      } finally {
        sqs.destroy();
      }
    }

    restoreEnv();
    if (logDir) console.log(`Logs: ${logDir}`);
  }, 45000);

  test('falha de ledger provoca rollback SQL e retry SQS', async () => {
    await runAtomicityScenario('ledger');
  }, 90000);

  test('falha de Outbox provoca rollback SQL e retry SQS', async () => {
    await runAtomicityScenario('outbox');
  }, 90000);

  test('referencia nunca encontrada termina REJECTED sem mover saldo', async () => {
    await runExpiredReferenceScenario();
  }, 180000);
});
