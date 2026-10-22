
import { describe, expect, test } from 'bun:test';

import {
  Wallet,
  InsufficientFundsError,
  InvalidWalletAmountError,
  InvalidInitialBalanceError,
} from './wallet.js';

import {
  Money,
  CurrencyMismatchError,
} from '../value-objects/money.js';

describe('Wallet', () => {
  const createWallet = () => {
    return Wallet.open({
      id: 'wallet-123',
      playerId: 'player-123',
      initialBalance: Money.from({
        amount: '100.00',
        currency: 'BRL',
      }),
    });
  };

  test('deve criar uma carteira com saldo inicial', () => {
    const wallet = createWallet();

    expect(wallet.id).toBe('wallet-123');
    expect(wallet.playerId).toBe('player-123');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.toString()).toBe('100.00 BRL');
    expect(wallet.version).toBe(1);
  });

  test('deve permitir carteira com saldo zero', () => {
    const wallet = Wallet.open({
      id: 'wallet-456',
      playerId: 'player-456',
      initialBalance: Money.zero('BRL'),
    });

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test('deve debitar corretamente', () => {
    const wallet = createWallet();

    const movement = wallet.debit(
      Money.from({
        amount: '30.00',
        currency: 'BRL',
      }),
    );

    expect(wallet.balance.toString()).toBe('70.00 BRL');
    expect(wallet.version).toBe(2);

    expect(movement.direction).toBe('DEBIT');
    expect(movement.balanceBefore.toString())
      .toBe('100.00 BRL');
    expect(movement.balanceAfter.toString())
      .toBe('70.00 BRL');
  });

  test('deve creditar corretamente', () => {
    const wallet = createWallet();

    const movement = wallet.credit(
      Money.from({
        amount: '50.00',
        currency: 'BRL',
      }),
    );

    expect(wallet.balance.toString()).toBe('150.00 BRL');
    expect(wallet.version).toBe(2);

    expect(movement.direction).toBe('CREDIT');
  });

  test('não deve permitir saldo negativo', () => {
    const wallet = createWallet();

    const amount = Money.from({
      amount: '150.00',
      currency: 'BRL',
    });

    expect(() => wallet.debit(amount))
      .toThrow(InsufficientFundsError);

    expect(wallet.balance.toString()).toBe('100.00 BRL');
    expect(wallet.version).toBe(1);
  });

  test('deve permitir gastar exatamente o saldo', () => {
    const wallet = createWallet();

    wallet.debit(
      Money.from({
        amount: '100.00',
        currency: 'BRL',
      }),
    );

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(2);
  });

  test('deve rejeitar moeda diferente', () => {
    const wallet = createWallet();

    const usd = Money.from({
      amount: '10.00',
      currency: 'USD',
    });

    expect(() => wallet.debit(usd))
      .toThrow(CurrencyMismatchError);

    expect(() => wallet.credit(usd))
      .toThrow(CurrencyMismatchError);

    expect(wallet.version).toBe(1);
  });

  test('deve rejeitar movimentação de valor zero', () => {
    const wallet = createWallet();

    expect(() => wallet.debit(Money.zero('BRL')))
      .toThrow(InvalidWalletAmountError);

    expect(() => wallet.credit(Money.zero('BRL')))
      .toThrow(InvalidWalletAmountError);

    expect(wallet.version).toBe(1);
  });

  test('deve rejeitar movimentação negativa', () => {
    const wallet = createWallet();

    const negative = Money.zero('BRL').subtract(
      Money.from({
        amount: '10.00',
        currency: 'BRL',
      }),
    );

    expect(() => wallet.credit(negative))
      .toThrow(InvalidWalletAmountError);

    expect(() => wallet.debit(negative))
      .toThrow(InvalidWalletAmountError);
  });

  test('deve rejeitar saldo inicial negativo', () => {
    const negative = Money.zero('BRL').subtract(
      Money.from({
        amount: '10.00',
        currency: 'BRL',
      }),
    );

    expect(() =>
      Wallet.open({
        id: 'wallet-789',
        playerId: 'player-789',
        initialBalance: negative,
      }),
    ).toThrow(InvalidInitialBalanceError);
  });

  test('deve incrementar versão a cada alteração', () => {
    const wallet = createWallet();

    wallet.debit(Money.from({
      amount: '20.00',
      currency: 'BRL',
    }));

    wallet.credit(Money.from({
      amount: '50.00',
      currency: 'BRL',
    }));

    expect(wallet.balance.toString()).toBe('130.00 BRL');
    expect(wallet.version).toBe(3);
  });

  test('deve reidratar o estado persistido', () => {
    const createdAt = new Date('2026-01-01T10:00:00Z');
    const updatedAt = new Date('2026-01-02T10:00:00Z');

    const wallet = Wallet.rehydrate({
      id: 'wallet-123',
      playerId: 'player-123',
      currency: 'BRL',
      balance: Money.from({
        amount: '75.00',
        currency: 'BRL',
      }),
      version: 5,
      createdAt,
      updatedAt,
    });

    expect(wallet.balance.toString()).toBe('75.00 BRL');
    expect(wallet.version).toBe(5);
    expect(wallet.createdAt).toEqual(createdAt);
    expect(wallet.updatedAt).toEqual(updatedAt);
  });
});
