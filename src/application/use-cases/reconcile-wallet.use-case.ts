import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { EntityManager } from '@mikro-orm/postgresql';
import { Decimal } from 'decimal.js';

import {
  reconciliationChecks,
} from '../../infrastructure/observability/reconciliation.metrics.js';

interface ReconciliationRow {
  wallet_id: string;
  currency: string;
  stored_balance: string;
  calculated_balance: string;
  checked_entries: string;
  invalid_entries: string;
}

export interface ReconciliationResult {
  walletId: string;
  storedBalance: {
    amount: string;
    currency: string;
  };
  calculatedBalance: {
    amount: string;
    currency: string;
  };
  difference: {
    amount: string;
    currency: string;
  };
  consistent: boolean;
  checkedEntries: number;
}

// Função pura: podemos testar os cálculos
// sem acessar banco de dados ou NestJS.
export function buildReconciliationResult(
  row: ReconciliationRow,
): ReconciliationResult {
  const stored = new Decimal(row.stored_balance);

  const calculated = new Decimal(
    row.calculated_balance,
  );

  const difference = stored.minus(calculated);

  const count = BigInt(row.checked_entries);
  const invalidCount = BigInt(row.invalid_entries);

  if (count > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('LEDGER_COUNT_OUT_OF_RANGE');
  }

  return {
    walletId: row.wallet_id,
    storedBalance: {
      amount: stored.toFixed(2),
      currency: row.currency,
    },
    calculatedBalance: {
      amount: calculated.toFixed(2),
      currency: row.currency,
    },
    difference: {
      amount: difference.toFixed(2),
      currency: row.currency,
    },
    consistent:
      stored.equals(calculated) &&
      invalidCount === 0n,
    checkedEntries: Number(count),
  };
}

@Injectable()
export class ReconcileWalletUseCase {
  private readonly logger = new Logger(
    ReconcileWalletUseCase.name,
  );

  constructor(
    private readonly em: EntityManager,
  ) {}

  async execute(
    walletId: string,
  ): Promise<ReconciliationResult> {
    const rows = await this.em.fork().execute<
      ReconciliationRow[]
    >(
      `
      SELECT
        w.id AS wallet_id,
        w.currency,
        w.balance::text AS stored_balance,

        COALESCE(
          SUM(
            CASE
              WHEN l.direction = 'CREDIT'
                THEN l.amount
              WHEN l.direction = 'DEBIT'
                THEN -l.amount
              ELSE 0
            END
          ),
          0
        )::text AS calculated_balance,

        COUNT(l.id)::text AS checked_entries,

        COUNT(l.id) FILTER (
          WHERE
            l.currency IS DISTINCT FROM w.currency
            OR l.direction NOT IN (
              'CREDIT', 'DEBIT'
            )
        )::text AS invalid_entries

      FROM wallets AS w

      LEFT JOIN wallet_ledger_entries AS l
        ON l.wallet_id = w.id

      WHERE w.id = ?

      GROUP BY
        w.id,
        w.currency,
        w.balance
      `,
      [walletId],
    );

    const row = rows[0];

    if (!row) {
      throw new NotFoundException(
        'WALLET_NOT_FOUND',
      );
    }

    const result = buildReconciliationResult(row);

    const status = result.consistent
      ? 'consistent'
      : 'divergent';

    // Contabilizar a verificacao em métrica.
    reconciliationChecks.inc({
      result: status,
    });

    // Log estruturado sem payload financeiro completo.
    const log = JSON.stringify({
      action: 'wallet_reconciliation',
      walletId,
      status,
      checkedEntries: result.checkedEntries,
    });

    if (result.consistent) {
      this.logger.log(log);
    } else {
      // Divergencias precisam ser investigadas.
      // Nunca corrigimos saldo silenciosamente.
      this.logger.error(log);
    }

    return result;
  }
}
