import {
  describe,
  expect,
  test,
} from 'bun:test';

import {
  buildReconciliationResult,
} from './reconcile-wallet.use-case.js';

const walletId =
  '11111111-1111-4111-8111-111111111111';

function makeRow(
  stored: string,
  calculated: string,
  checkedEntries = '3',
  invalidEntries = '0',
) {
  return {
    wallet_id: walletId,
    currency: 'BRL',
    stored_balance: stored,
    calculated_balance: calculated,
    checked_entries: checkedEntries,
    invalid_entries: invalidEntries,
  };
}

describe('Wallet Reconciliation', () => {
  test('detecta saldo consistente', () => {
    const result = buildReconciliationResult(
      makeRow('120.00', '120.00'),
    );

    expect(result.consistent).toBe(true);
    expect(result.difference.amount).toBe('0.00');
    expect(result.checkedEntries).toBe(3);
  });

  test('detecta diferenca positiva', () => {
    const result = buildReconciliationResult(
      makeRow('120.00', '100.00'),
    );

    expect(result.consistent).toBe(false);
    expect(result.difference.amount).toBe('20.00');
  });

  test('detecta diferenca negativa', () => {
    const result = buildReconciliationResult(
      makeRow('90.00', '100.00'),
    );

    expect(result.consistent).toBe(false);
    expect(result.difference.amount).toBe('-10.00');
  });

  test('preserva precisao monetaria', () => {
    const result = buildReconciliationResult(
      makeRow(
        '999999999999.99',
        '999999999999.98',
      ),
    );

    expect(result.difference.amount).toBe('0.01');
  });

  test('aceita carteira vazia', () => {
    const result = buildReconciliationResult(
      makeRow('0.00', '0', '0'),
    );

    expect(result.consistent).toBe(true);
    expect(result.checkedEntries).toBe(0);
    expect(result.calculatedBalance.amount).toBe('0.00');
  });

  test('detecta lancamentos invalidos', () => {
    const result = buildReconciliationResult(
      makeRow('100.00', '100.00', '2', '1'),
    );

    expect(result.consistent).toBe(false);
  });
});
