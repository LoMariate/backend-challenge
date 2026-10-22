import { Wallet } from '../aggregates/wallet.js';

import {
  WalletLedgerEntry,
  LedgerDirection,
} from '../entities/wallet-ledger-entry.js';

import { type MoneyProps } from
  '../value-objects/money.js';

import {
  IntegrationEvent,
  type EventContext,
} from './integration-event.js';

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged
  extends IntegrationEvent<WalletBalanceChangedData> {

  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    ctx: EventContext,
  ): WalletBalanceChanged {
    if (wallet.id !== entry.walletId) {
      throw new Error('WALLET_LEDGER_MISMATCH');
    }

    if (!wallet.balance.equals(entry.balanceAfter)) {
      throw new Error('WALLET_BALANCE_MISMATCH');
    }

    return new WalletBalanceChanged({
      eventId: ctx.eventId,
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
