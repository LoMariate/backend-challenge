
import { describe, expect, test } from 'bun:test';

import {
  WalletLedgerEntry,
  LedgerDirection,
  InvalidLedgerEntryError,
  type CreateLedgerEntryProps,
} from './wallet-ledger-entry.js';

import {
  Money,
  CurrencyMismatchError,
} from '../value-objects/money.js';

import { Wallet } from '../aggregates/wallet.js';

// Facilita criar valores para os testes
const brl = (amount: string): Money => {
  return Money.from({
    amount,
    currency: 'BRL',
  });
};

// Cria um lançamento padrão de crédito
const createEntry = (
  overrides: Partial<CreateLedgerEntryProps> = {},
): WalletLedgerEntry => {
  return WalletLedgerEntry.create({
    id: 'ledger-123',
    walletId: 'wallet-123',
    transactionId: 'transaction-123',
    direction: LedgerDirection.Credit,
    money: brl('50.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('150.00'),
    ...overrides,
  });
};

describe('WalletLedgerEntry', () => {
  test('deve criar um crédito válido', () => {
    const entry = createEntry();

    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.toString())
      .toBe('150.00 BRL');
  });

  test('deve criar um débito válido', () => {
    const entry = createEntry({
      direction: LedgerDirection.Debit,
      money: brl('30.00'),
      balanceAfter: brl('70.00'),
    });

    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.toString())
      .toBe('70.00 BRL');
  });

  test('deve permitir crédito de abertura', () => {
    const entry = createEntry({
      transactionId: 'opening-123',
      money: brl('100.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('100.00'),
    });

    expect(entry.isBalanced()).toBe(true);
  });

  test('deve rejeitar crédito inconsistente', () => {
    expect(() =>
      createEntry({
        balanceAfter: brl('140.00'),
      }),
    ).toThrow('UNBALANCED_LEDGER_ENTRY');
  });

  test('deve rejeitar débito inconsistente', () => {
    expect(() =>
      createEntry({
        direction: LedgerDirection.Debit,
        money: brl('30.00'),
        balanceAfter: brl('80.00'),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('deve rejeitar valor zero', () => {
    expect(() =>
      createEntry({
        money: brl('0.00'),
      }),
    ).toThrow('INVALID_LEDGER_AMOUNT');
  });

  test('deve rejeitar valor negativo', () => {
    const negative = brl('0.00').subtract(
      brl('10.00'),
    );

    expect(() =>
      createEntry({
        money: negative,
      }),
    ).toThrow('INVALID_LEDGER_AMOUNT');
  });

  test('deve rejeitar moedas diferentes', () => {
    expect(() =>
      createEntry({
        balanceAfter: Money.from({
          amount: '150.00',
          currency: 'USD',
        }),
      }),
    ).toThrow(CurrencyMismatchError);
  });

  test('deve rejeitar saldo negativo', () => {
    const negative = brl('0.00').subtract(
      brl('20.00'),
    );

    expect(() =>
      createEntry({
        direction: LedgerDirection.Debit,
        money: brl('120.00'),
        balanceAfter: negative,
      }),
    ).toThrow('NEGATIVE_LEDGER_BALANCE');
  });

  test('deve rejeitar identificadores vazios', () => {
    expect(() =>
      createEntry({
        transactionId: '',
      }),
    ).toThrow('INVALID_LEDGER_IDENTIFIERS');
  });

  test('deve proteger a imutabilidade', () => {
    const date = new Date('2026-01-01T10:00:00Z');

    const entry = createEntry({
      createdAt: date,
    });

    date.setUTCFullYear(2000);

    const exposedDate = entry.createdAt;
    exposedDate.setUTCFullYear(2001);

    expect(entry.createdAt.toISOString())
      .toBe('2026-01-01T10:00:00.000Z');

    expect(Object.isFrozen(entry)).toBe(true);
  });

  test('deve reidratar sem validar novamente', () => {
    const entry = WalletLedgerEntry.rehydrate({
      id: 'ledger-123',
      walletId: 'wallet-123',
      transactionId: 'transaction-123',
      direction: LedgerDirection.Credit,
      money: brl('50.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('140.00'),
      createdAt: new Date('2026-01-01T10:00:00Z'),
    });

    // Reconstrói o estado persistido, mesmo inconsistente
    expect(entry.isBalanced()).toBe(false);
  });

  test('deve integrar com a Wallet', () => {
    const wallet = Wallet.open({
      id: 'wallet-123',
      playerId: 'player-123',
      initialBalance: brl('100.00'),
    });

    const movement = wallet.debit(brl('30.00'));

    const entry = WalletLedgerEntry.create({
      id: 'ledger-123',
      walletId: wallet.id,
      transactionId: 'bet-123',
      direction:
        movement.direction === 'DEBIT'
          ? LedgerDirection.Debit
          : LedgerDirection.Credit,
      money: movement.money,
      balanceBefore: movement.balanceBefore,
      balanceAfter: movement.balanceAfter,
    });

    expect(entry.isBalanced()).toBe(true);
    expect(wallet.balance.equals(entry.balanceAfter))
      .toBe(true);
    expect(wallet.version).toBe(2);
  });
});
