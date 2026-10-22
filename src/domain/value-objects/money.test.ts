import { describe, expect, test } from 'bun:test';

import {
  Money,
  InvalidMoneyAmountError,
  InvalidCurrencyError,
  CurrencyMismatchError,
} from './money.js';

describe('Money', () => {
  test('deve criar um valor válido', () => {
    const money = Money.from({
      amount: '100.00',
      currency: 'BRL',
    });

    expect(money.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
  });

  test('deve criar um valor zero', () => {
    const money = Money.zero('BRL');

    expect(money.isZero()).toBe(true);
    expect(money.toString()).toBe('0.00 BRL');
  });

  test('deve somar corretamente', () => {
    const a = Money.from({
      amount: '0.10',
      currency: 'BRL',
    });

    const b = Money.from({
      amount: '0.20',
      currency: 'BRL',
    });

    expect(a.add(b).toString()).toBe('0.30 BRL');
  });

  test('deve subtrair corretamente', () => {
    const a = Money.from({
      amount: '100.00',
      currency: 'BRL',
    });

    const b = Money.from({
      amount: '30.00',
      currency: 'BRL',
    });

    expect(a.subtract(b).toString())
      .toBe('70.00 BRL');
  });

  test('deve preservar a imutabilidade', () => {
    const original = Money.from({
      amount: '100.00',
      currency: 'BRL',
    });

    const novo = original.subtract(
      Money.from({
        amount: '30.00',
        currency: 'BRL',
      }),
    );

    expect(original.toString()).toBe('100.00 BRL');
    expect(novo.toString()).toBe('70.00 BRL');
    expect(novo).not.toBe(original);
  });

  test('deve permitir resultado interno negativo', () => {
    const a = Money.from({
      amount: '10.00',
      currency: 'BRL',
    });

    const b = Money.from({
      amount: '20.00',
      currency: 'BRL',
    });

    const result = a.subtract(b);

    expect(result.isNegative()).toBe(true);
    expect(result.toString()).toBe('-10.00 BRL');
  });

  test('deve inverter o sinal', () => {
    const money = Money.from({
      amount: '25.00',
      currency: 'BRL',
    });

    const negated = money.negate();

    expect(negated.toString()).toBe('-25.00 BRL');
    expect(negated.negate().equals(money)).toBe(true);
  });

  test('deve comparar valores corretamente', () => {
    const a = Money.from({
      amount: '10.00',
      currency: 'BRL',
    });

    const b = Money.from({
      amount: '20.00',
      currency: 'BRL',
    });

    expect(a.isLessThan(b)).toBe(true);
    expect(a.isPositive()).toBe(true);
    expect(a.equals(b)).toBe(false);
  });

  test('deve rejeitar moedas diferentes', () => {
    const brl = Money.from({
      amount: '10.00',
      currency: 'BRL',
    });

    const usd = Money.from({
      amount: '10.00',
      currency: 'USD',
    });

    expect(() => brl.add(usd))
      .toThrow(CurrencyMismatchError);

    expect(() => brl.subtract(usd))
      .toThrow(CurrencyMismatchError);

    expect(() => brl.equals(usd))
      .toThrow(CurrencyMismatchError);
  });

  test('deve rejeitar valores inválidos', () => {
    const invalidValues = [
      '',
      '-10.00',
      '10.123',
      'NaN',
      'Infinity',
      '1e3',
      '10',
      '10.0',
      ' 10.00 ',
    ];

    for (const amount of invalidValues) {
      expect(() =>
        Money.from({
          amount,
          currency: 'BRL',
        }),
      ).toThrow(InvalidMoneyAmountError);
    }
  });

  test('deve rejeitar moeda inválida', () => {
    expect(() =>
      Money.from({
        amount: '10.00',
        currency: 'brl',
      }),
    ).toThrow(InvalidCurrencyError);
  });

  test('deve manter precisão com valores grandes', () => {
    const a = Money.from({
      amount: '999999999999.99',
      currency: 'BRL',
    });

    const b = Money.from({
      amount: '0.01',
      currency: 'BRL',
    });

    expect(a.add(b).toString())
      .toBe('1000000000000.00 BRL');
  });
});