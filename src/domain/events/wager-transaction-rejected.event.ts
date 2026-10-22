import { Wallet } from '../aggregates/wallet.js';

import {
  WagerTransaction,
  WagerTransactionStatus,
  WagerTransactionKind,
  FailureCode,
} from '../entities/wager-transaction.js';

import type { MoneyProps } from
  '../value-objects/money.js';

import {
  IntegrationEvent,
  type EventContext,
} from './integration-event.js';

interface RejectedData {
  transactionId: string;
  walletId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  balance: MoneyProps;
  failureCode: FailureCode;
}

export class WagerTransactionRejected
  extends IntegrationEvent<RejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    wallet: Wallet,
    ctx: EventContext,
  ): WagerTransactionRejected {
    if (
      transaction.status !==
        WagerTransactionStatus.Rejected ||
      !transaction.failureCode
    ) {
      throw new Error('TRANSACTION_NOT_REJECTED');
    }

    if (transaction.walletId !== wallet.id) {
      throw new Error('TRANSACTION_WALLET_MISMATCH');
    }

    return new WagerTransactionRejected({
      eventId: ctx.eventId,
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        transactionId: transaction.id,
        walletId: wallet.id,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        balance: wallet.balance.toJSON(),
        failureCode: transaction.failureCode,
      },
    });
  }
}
