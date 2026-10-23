import { Injectable, Logger } from '@nestjs/common';

import { EntityManager } from '@mikro-orm/postgresql';

import {
  ProcessWagerTransactionUseCase,
} from '../../application/use-cases/process-wager-transaction.use-case.js';

@Injectable()
export class PendingReferenceWorker {
  private readonly logger = new Logger(
    PendingReferenceWorker.name,
  );

  constructor(
    private readonly em: EntityManager,
    private readonly processWager:
      ProcessWagerTransactionUseCase,
  ) {}

  async runBatch(): Promise<number> {
    const rows = await this.em.fork().execute<
      { id: string }[]
    >(
      `
      SELECT id
      FROM wager_transactions
      WHERE status = 'PENDING_REFERENCE'
        AND next_reference_attempt_at <= NOW()
      ORDER BY next_reference_attempt_at, id
      LIMIT 20
      `,
    );

    for (const row of rows) {
      try {
        await this.processWager.retryPendingReference(
          row.id,
        );

        this.logger.log(
          JSON.stringify({
            action: 'pending_reference_checked',
            transactionId: row.id,
          }),
        );
      } catch (error) {
        const reason =
          error instanceof Error
            ? error.message
            : 'UNKNOWN_ERROR';

        this.logger.warn(
          JSON.stringify({
            action: 'pending_reference_retry_failed',
            transactionId: row.id,
            reason,
          }),
        );
      }
    }

    return rows.length;
  }
}
