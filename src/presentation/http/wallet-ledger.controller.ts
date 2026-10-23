import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';

import { EntityManager } from '@mikro-orm/postgresql';

import {
  decodeLedgerCursor,
  encodeLedgerCursor,
} from '../../application/services/ledger-cursor.js';

interface LedgerRow {
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date | string;
  cursor_created_at: string;
}

function parseLedgerLimit(raw: unknown): number {
  if (raw === undefined) {
    return 50;
  }

  if (
    typeof raw !== 'string' ||
    !/^\d{1,3}$/.test(raw)
  ) {
    throw new BadRequestException(
      'INVALID_LEDGER_LIMIT',
    );
  }

  const limit = Number(raw);

  if (limit < 1 || limit > 100) {
    throw new BadRequestException(
      'LEDGER_LIMIT_OUT_OF_RANGE',
    );
  }

  return limit;
}

@Controller('wallets')
export class WalletLedgerController {
  constructor(
    private readonly em: EntityManager,
  ) {}

  @Get(':walletId/ledger')
  async getLedger(
    @Param('walletId', new ParseUUIDPipe({
      version: 'all',
    }))
    walletId: string,

    @Query('limit')
    rawLimit: unknown,

    @Query('cursor')
    rawCursor: unknown,
  ) {
    const limit = parseLedgerLimit(rawLimit);

    const cursor =
      rawCursor === undefined
        ? undefined
        : decodeLedgerCursor(rawCursor, walletId);

    const em = this.em.fork();

    // 1. Confirmar que a wallet existe.
    const wallets = await em.execute<{ id: string }[]>(
      `
      SELECT id
      FROM wallets
      WHERE id = ?
      `,
      [walletId],
    );

    if (wallets.length === 0) {
      throw new NotFoundException(
        'WALLET_NOT_FOUND',
      );
    }

    // 2. Se existe cursor, buscar somente registros
    // anteriores à posição informada.
    const cursorCondition = cursor
      ? `
        AND (l.created_at, l.id) <
            (
              CAST(? AS timestamptz),
              CAST(? AS uuid)
            )
      `
      : '';

    const params: unknown[] = [walletId];

    if (cursor) {
      params.push(cursor.createdAt, cursor.id);
    }

    // Buscamos um registro extra para descobrir
    // se ainda existe outra página.
    params.push(limit + 1);

    const rows = await em.execute<LedgerRow[]>(
      `
      SELECT
        l.id,
        l.wallet_id,
        l.transaction_id,
        l.direction,
        l.amount,
        l.currency,
        l.balance_before,
        l.balance_after,
        l.created_at,

        -- Preserve a precisão original do timestamp
        -- ao gerar o próximo cursor.
        to_char(
          l.created_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) AS cursor_created_at

      FROM wallet_ledger_entries AS l

      WHERE l.wallet_id = ?
      ${cursorCondition}

      ORDER BY
        l.created_at DESC,
        l.id DESC

      LIMIT ?
      `,
      params,
    );

    // 3. Separar apenas os registros desta página.
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);

    // 4. Montar o cursor a partir do último registro
    // efetivamente retornado.
    const last = pageRows.at(-1);

    const nextCursor =
      hasMore && last
        ? encodeLedgerCursor({
            version: 1,
            walletId,
            createdAt: last.cursor_created_at,
            id: last.id,
          })
        : null;

    // 5. Construir resposta com dinheiro em string.
    const items = pageRows.map((entry) => ({
      id: entry.id,
      transactionId: entry.transaction_id,
      direction: entry.direction,

      money: {
        amount: entry.amount,
        currency: entry.currency,
      },

      balanceBefore: {
        amount: entry.balance_before,
        currency: entry.currency,
      },

      balanceAfter: {
        amount: entry.balance_after,
        currency: entry.currency,
      },

      createdAt: entry.created_at,
    }));

    return {
      walletId,
      items,
      pageInfo: {
        limit,
        hasMore,
        nextCursor,
      },
    };
  }
}
