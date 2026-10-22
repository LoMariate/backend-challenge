import { Wallet } from '../aggregates/wallet.js';

import {
  WagerTransaction,
  WagerTransactionStatus,
  WagerTransactionKind,
} from '../entities/wager-transaction.js';

import { type MoneyProps } from
  '../value-objects/money.js';

import {
  IntegrationEvent,
  type EventContext,
} from './integration-event.js';

export interface WagerTransactionProcessedData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  balance: MoneyProps;
  status: 'PROCESSED';
}

export class WagerTransactionProcessed
  extends IntegrationEvent<WagerTransactionProcessedData> {

  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    wallet: Wallet,
    ctx: EventContext,
  ): WagerTransactionProcessed {
    if (
      transaction.status !==
      WagerTransactionStatus.Processed
    ) {
      throw new Error('TRANSACTION_NOT_PROCESSED');
    }

    if (transaction.walletId !== wallet.id) {
      throw new Error('TRANSACTION_WALLET_MISMATCH');
    }

    return new WagerTransactionProcessed({
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
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        balance: wallet.balance.toJSON(),
        status: 'PROCESSED',
      },
    });
  }
}
