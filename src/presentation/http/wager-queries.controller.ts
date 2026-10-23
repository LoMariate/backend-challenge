import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';

import { EntityManager } from '@mikro-orm/postgresql';

// Representa o formato retornado pelo PostgreSQL.
interface WagerTransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: string;
  status: string;
  amount: string;
  currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  observed_balance: string | null;
  failure_code: string | null;
  created_at: Date;
  processed_at: Date | null;
}

// Consulta compartilhada pelos dois endpoints.
const SELECT_TRANSACTION = `
  SELECT
    id,
    provider_id,
    external_transaction_id,
    wallet_id,
    player_id,
    round_id,
    game_id,
    kind,
    status,
    amount,
    currency,
    reference_external_transaction_id,
    reference_transaction_id,
    observed_balance,
    failure_code,
    created_at,
    processed_at
  FROM wager_transactions
`;

@Controller()
export class WagerQueriesController {
  constructor(
    private readonly em: EntityManager,
  ) {}

  // GET /wagering/transactions/:transactionId
  @Get('wagering/transactions/:transactionId')
  async getById(
    @Param(
      'transactionId',
      new ParseUUIDPipe({ version: 'all' }),
    )
    transactionId: string,
  ) {
    const rows =
      await this.em.fork().execute<WagerTransactionRow[]>(
        `
        ${SELECT_TRANSACTION}
        WHERE id = ?
        LIMIT 1
        `,
        [transactionId],
      );

    return this.toResponse(rows[0]);
  }

  // GET /providers/:providerId/wagering/transactions/:externalTransactionId
  @Get(
    'providers/:providerId/wagering/transactions/:externalTransactionId',
  )
  async getByProvider(
    @Param('providerId')
    providerId: string,

    @Param('externalTransactionId')
    externalTransactionId: string,
  ) {
    if (
      !providerId?.trim() ||
      !externalTransactionId?.trim() ||
      providerId.length > 100 ||
      externalTransactionId.length > 255
    ) {
      throw new BadRequestException(
        'INVALID_TRANSACTION_IDENTIFIERS',
      );
    }

    const rows =
      await this.em.fork().execute<WagerTransactionRow[]>(
        `
        ${SELECT_TRANSACTION}
        WHERE provider_id = ?
          AND external_transaction_id = ?
        LIMIT 1
        `,
        [providerId, externalTransactionId],
      );

    return this.toResponse(rows[0]);
  }

  // As duas consultas produzem a mesma resposta.
  private toResponse(row?: WagerTransactionRow) {
    if (!row) {
      throw new NotFoundException(
        'WAGER_TRANSACTION_NOT_FOUND',
      );
    }

    return {
      transactionId: row.id,
      providerId: row.provider_id,
      externalTransactionId:
        row.external_transaction_id,

      walletId: row.wallet_id,
      playerId: row.player_id,
      roundId: row.round_id,
      gameId: row.game_id,

      kind: row.kind,
      status: row.status,

      money: {
        amount: row.amount,
        currency: row.currency,
      },

      referenceExternalTransactionId:
        row.reference_external_transaction_id,

      referenceTransactionId:
        row.reference_transaction_id,

      // Saldo histórico observado ao registrar
      // o resultado da operação.
      observedBalance:
        row.observed_balance === null
          ? null
          : {
              amount: row.observed_balance,
              currency: row.currency,
            },

      failureCode: row.failure_code,
      createdAt: row.created_at,
      processedAt: row.processed_at,
    };
  }
}
