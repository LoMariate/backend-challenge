import {
  describe,
  expect,
  test,
} from 'bun:test';

import {
  encodeLedgerCursor,
  decodeLedgerCursor,
  type LedgerCursor,
} from './ledger-cursor.js';

const walletId =
  '11111111-1111-4111-8111-111111111111';

const cursor: LedgerCursor = {
  version: 1,
  walletId,
  createdAt: '2026-10-22T10:00:00.123456Z',
  id: '22222222-2222-4222-8222-222222222222',
};

describe('Ledger Cursor', () => {
  test('codifica e decodifica corretamente', () => {
    const encoded = encodeLedgerCursor(cursor);
    const decoded = decodeLedgerCursor(
      encoded,
      walletId,
    );

    expect(decoded).toEqual(cursor);
  });

  test('rejeita cursor de outra wallet', () => {
    const encoded = encodeLedgerCursor(cursor);

    expect(() =>
      decodeLedgerCursor(
        encoded,
        '33333333-3333-4333-8333-333333333333',
      ),
    ).toThrow('INVALID_LEDGER_CURSOR');
  });

  test('rejeita cursor malformado', () => {
    expect(() =>
      decodeLedgerCursor(
        'valor-invalido',
        walletId,
      ),
    ).toThrow('INVALID_LEDGER_CURSOR');
  });

  test('rejeita cursor vazio', () => {
    expect(() =>
      decodeLedgerCursor('', walletId),
    ).toThrow('INVALID_LEDGER_CURSOR');
  });

  test('rejeita versão desconhecida', () => {
    const encoded = Buffer.from(
      JSON.stringify({
        ...cursor,
        version: 99,
      }),
    ).toString('base64url');

    expect(() =>
      decodeLedgerCursor(
        encoded,
        walletId,
      ),
    ).toThrow('INVALID_LEDGER_CURSOR');
  });
});
