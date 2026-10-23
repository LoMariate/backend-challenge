import 'reflect-metadata';
import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { AppModule } from '../../src/app.module.js';

type Wallet = { id: string; playerId: string };
type DbIndex = {
  is_unique: boolean;
  key_columns: string[];
  predicate: string | null;
};
type DbFk = { definition: string };
type DbTrigger = { name: string; type_mask: number | string };
type MoneyColumn = {
  data_type: string;
  numeric_scale: number | null;
};

let app: INestApplication | undefined;
let em: EntityManager;
let apiUrl: string;
let wallet: Wallet;
let ledgerId: string;

function checkTestDatabase(): void {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL_OBRIGATORIA');

  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (
    !/^backend_challenge_schema_audit_[0-9a-f]{12}$/.test(database) ||
    !['127.0.0.1', 'localhost'].includes(url.hostname)
  ) {
    throw new Error(
      'AUDITORIA_EXIGE_BANCO_DESCARTAVEL_LOCAL_COM_PREFIXO_schema_audit',
    );
  }
}

async function query<T>(statement: string, params: unknown[] = []): Promise<T[]> {
  return em.fork().execute<T[]>(statement, params);
}

async function indexes(table: string): Promise<DbIndex[]> {
  return query<DbIndex>(
    `
    SELECT
      i.indisunique AS is_unique,
      ARRAY(
        SELECT replace(pg_get_indexdef(i.indexrelid, n, true), '"', '')
        FROM generate_series(1, i.indnkeyatts) AS n
        ORDER BY n
      ) AS key_columns,
      pg_get_expr(i.indpred, i.indrelid) AS predicate
    FROM pg_index AS i
    WHERE i.indrelid = to_regclass(?)
    `,
    [`public.${table}`],
  );
}

async function hasUniqueKey(
  table: string,
  columns: string[],
  requiredPredicateWords: string[] = [],
): Promise<boolean> {
  const result = await indexes(table);
  return result.some((index) => {
    const sameKeys =
      index.key_columns.length === columns.length &&
      columns.every((col) => index.key_columns.includes(col));
    const predicate = (index.predicate ?? '').toUpperCase();
    const predicateValid = requiredPredicateWords.length === 0
      ? index.predicate === null // unicidade incondicional
      : requiredPredicateWords.every((word) => predicate.includes(word.toUpperCase()));
    return index.is_unique && sameKeys && predicateValid;
  });
}

async function foreignKeys(table: string): Promise<DbFk[]> {
  return query<DbFk>(
    `
    SELECT pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint AS c
    WHERE c.conrelid = to_regclass(?) AND c.contype = 'f'
    `,
    [`public.${table}`],
  );
}

function containsFk(fks: DbFk[], column: string, target: string): boolean {
  return fks.some((fk) => {
    const text = fk.definition.replaceAll('"', '').toLowerCase();
    return text.includes(`foreign key (${column})`) &&
      (text.includes(`references ${target}(`) ||
        text.includes(`references public.${target}(`));
  });
}

// Executa uma alteração deliberadamente inválida dentro de uma transação.
// Mesmo que o schema NÃO a bloqueie, a transação é revertida imediatamente.
// Portanto nenhum UPDATE/DELETE/TRUNCATE de auditoria é confirmado.
async function assertRejectedByDatabase(
  title: string,
  statement: string,
  params: unknown[] = [],
): Promise<void> {
  const allowedMarker = `AUDIT_INVALID_OPERATION_WAS_ALLOWED:${title}`;
  let failed = false;

  try {
    await em.fork().transactional(async (tx) => {
      await tx.execute(statement, params);
      throw new Error(allowedMarker);
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes(allowedMarker)) {
      throw new Error(
        `${title}: o PostgreSQL permitiu a operacao proibida; ` +
        'a transacao de teste foi revertida.',
      );
    }
    failed = true;
  }

  expect(failed).toBe(true);
}

async function moneyColumn(table: string, column: string): Promise<MoneyColumn> {
  const rows = await query<MoneyColumn>(
    `
    SELECT data_type, numeric_scale
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ?
      AND column_name = ?
    `,
    [table, column],
  );
  if (!rows[0]) throw new Error(`MISSING_COLUMN:${table}.${column}`);
  return rows[0];
}

describe('Auditoria do schema financeiro PostgreSQL', () => {
  beforeAll(async () => {
    checkTestDatabase();

    app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');

    const address = app.getHttpServer().address() as AddressInfo;
    apiUrl = `http://127.0.0.1:${address.port}`;
    em = app.get(EntityManager);

    // Seed real pela API, preservando todas as regras de abertura de wallet.
    const playerId = randomUUID();
    const response = await fetch(`${apiUrl}/wallets`, {
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
      throw new Error(`AUDIT_WALLET_CREATION_FAILED:${response.status}:${body}`);
    }
    wallet = { id: (JSON.parse(body) as { id: string }).id, playerId };

    const entries = await query<{ id: string }>(
      `SELECT id::text AS id FROM wallet_ledger_entries
       WHERE wallet_id = ? LIMIT 1`,
      [wallet.id],
    );
    if (!entries[0]) throw new Error('OPENING_LEDGER_NOT_CREATED');
    ledgerId = entries[0].id;
  }, 45000);

  afterAll(async () => {
    if (app) await app.close();
  }, 30000);

  test('dinheiro usa NUMERIC com escala exata de 2 casas', async () => {
    const columns = [
      ['wallets', 'balance'],
      ['wager_transactions', 'amount'],
      ['wallet_ledger_entries', 'amount'],
      ['wallet_ledger_entries', 'balance_before'],
      ['wallet_ledger_entries', 'balance_after'],
    ] as const;

    for (const [table, name] of columns) {
      const col = await moneyColumn(table, name);
      expect(col.data_type).toBe('numeric');
      expect(Number(col.numeric_scale)).toBe(2);
    }
  });

  test('schema impede saldo negativo, sem depender do dominio', async () => {
    await assertRejectedByDatabase(
      'WALLET_NEGATIVE_BALANCE',
      'UPDATE wallets SET balance = -0.01 WHERE id = ?',
      [wallet.id],
    );

    const rows = await query<{ balance: string; version: number }>(
      'SELECT balance::text AS balance, version FROM wallets WHERE id = ?',
      [wallet.id],
    );
    expect(rows[0]?.balance).toBe('100.00');
    expect(Number(rows[0]?.version)).toBe(1);
  });

  test('indexes de unicidade financeira e de idempotencia', async () => {
    expect(await hasUniqueKey('wallets', ['player_id', 'currency'])).toBe(true);
    expect(await hasUniqueKey('wager_transactions', ['provider_id', 'external_transaction_id'])).toBe(true);
    expect(await hasUniqueKey('wager_transactions', ['provider_id', 'idempotency_key'])).toBe(true);
    expect(await hasUniqueKey('inbox_messages', ['consumer_name', 'message_id'])).toBe(true);

    // Uma transacao financeira pode ter no maximo um lancamento no ledger.
    const uniqueLedgerTx =
      await hasUniqueKey('wallet_ledger_entries', ['transaction_id']) ||
      await hasUniqueKey('wallet_ledger_entries', ['wallet_id', 'transaction_id']);
    expect(uniqueLedgerTx).toBe(true);

    // REFUND e ROLLBACK da mesma referencia nao podem duplicar por tipo.
    expect(await hasUniqueKey(
      'wager_transactions',
      ['reference_transaction_id', 'kind'],
      ['PROCESSED', 'REFUND', 'ROLLBACK'],
    )).toBe(true);
  });

  test('ledger possui chaves estrangeiras para wallet e transacao', async () => {
    const fks = await foreignKeys('wallet_ledger_entries');
    expect(containsFk(fks, 'wallet_id', 'wallets')).toBe(true);
    expect(containsFk(fks, 'transaction_id', 'wager_transactions')).toBe(true);
  });

  test('referencia interna de reversao possui FK para transacao', async () => {
    const fks = await foreignKeys('wager_transactions');
    expect(containsFk(fks, 'reference_transaction_id', 'wager_transactions')).toBe(true);
  });

  test('ledger possui triggers ativos contra UPDATE, DELETE e TRUNCATE', async () => {
    const triggers = await query<DbTrigger>(
      `
      SELECT tgname AS name, tgtype AS type_mask
      FROM pg_trigger
      WHERE tgrelid = to_regclass('public.wallet_ledger_entries')
        AND NOT tgisinternal
        AND tgenabled <> 'D'
      `,
    );

    // Bits de evento no pg_trigger.tgtype:
    // UPDATE=16, DELETE=8, TRUNCATE=32.
    for (const flag of [16, 8, 32]) {
      expect(triggers.some((tr) => (Number(tr.type_mask) & flag) !== 0))
        .toBe(true);
    }

    await assertRejectedByDatabase(
      'IMMUTABLE_LEDGER_UPDATE',
      'UPDATE wallet_ledger_entries SET amount = amount + 0.01 WHERE id = ?',
      [ledgerId],
    );
    await assertRejectedByDatabase(
      'IMMUTABLE_LEDGER_DELETE',
      'DELETE FROM wallet_ledger_entries WHERE id = ?',
      [ledgerId],
    );
    await assertRejectedByDatabase(
      'IMMUTABLE_LEDGER_TRUNCATE',
      'TRUNCATE TABLE wallet_ledger_entries',
    );

    const after = await query<{ amount: string }>(
      'SELECT amount::text AS amount FROM wallet_ledger_entries WHERE id = ?',
      [ledgerId],
    );
    expect(after[0]?.amount).toBe('100.00');
  });

  test('wallet e ledger continuam reconciliados', async () => {
    const response = await fetch(`${apiUrl}/wallets/${wallet.id}/reconciliation`, {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
    });
    expect(response.status).toBe(200);
    const data = await response.json() as {
      consistent: boolean;
      difference: { amount: string };
      checkedEntries: number;
    };
    expect(data.consistent).toBe(true);
    expect(data.difference.amount).toBe('0.00');
    expect(data.checkedEntries).toBe(1);
  });
});
