import { Wallet } from '../aggregates/wallet.js';

import {
  WagerTransaction,
  WagerTransactionStatus,
} from '../entities/wager-transaction.js';

import type { MoneyProps } from
  '../value-objects/money.js';

import {
  IntegrationEvent,
  type EventContext,
} from './integration-event.js';

interface PendingReferenceData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  referenceExternalTransactionId: string;
  kind: string;
  money: MoneyProps;
}

export class WagerTransactionPendingReference
  extends IntegrationEvent<PendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    wallet: Wallet,
    ctx: EventContext,
  ): WagerTransactionPendingReference {
    if (
      transaction.status !==
      WagerTransactionStatus.PendingReference
    ) {
      throw new Error('TRANSACTION_NOT_PENDING_REFERENCE');
    }

    if (!transaction.referenceExternalTransactionId) {
      throw new Error('REFERENCE_REQUIRED');
    }

    return new WagerTransactionPendingReference({
      eventId: ctx.eventId,
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        transactionId: transaction.id,
        walletId: wallet.id,
        providerId: transaction.providerId,
        externalTransactionId:
          transaction.externalTransactionId,
        referenceExternalTransactionId:
          transaction.referenceExternalTransactionId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
      },
    });
  }
}
