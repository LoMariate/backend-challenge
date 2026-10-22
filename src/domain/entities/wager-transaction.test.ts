import { describe, expect, test } from 'bun:test';

import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  FailureCode,
  InvalidWagerTransactionError,
  InvalidTransactionStateError,
  InvalidWagerReferenceError,
  type CreateWagerTransactionProps,
} from './wager-transaction.js';

import { LedgerDirection } from './wallet-ledger-entry.js';

import { Money } from '../value-objects/money.js';

const brl = (amount: string): Money =>
  Money.from({ amount, currency: 'BRL' });

const hash = 'a'.repeat(64);

const createTransaction = (
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction =>
  WagerTransaction.create({
    id: 'transaction-1',
    providerId: 'provider-a',
    externalTransactionId: 'bet-1',
    idempotencyKey: 'provider-a:bet-1',
    payloadHash: hash,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Bet,
    money: brl('30.00'),
    ...overrides,
  });

// Cria uma BET já processada para servir de referência
const processedBet = (): WagerTransaction => {
  const bet = createTransaction();

  bet.markProcessed(
    undefined,
    new Date('2026-01-01T10:00:00Z'),
  );

  return bet;
};

const createReversal = (
  kind: Kind.Refund | Kind.Rollback,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction =>
  createTransaction({
    id: 'reversal-1',
    externalTransactionId: 'reversal-1',
    idempotencyKey: 'provider-a:reversal-1',
    kind,
    referenceExternalTransactionId: 'bet-1',
    ...overrides,
  });

describe('WagerTransaction', () => {
  test('deve nascer em PENDING', () => {
    const tx = createTransaction();

    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.failureCode).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
  });

  test('deve processar uma BET', () => {
    const tx = createTransaction();

    const date = new Date('2026-01-01T10:00:00Z');

    tx.markProcessed(undefined, date);

    expect(tx.status).toBe(Status.Processed);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.processedAt).toEqual(date);
  });

  test('não deve alterar transação processada', () => {
    const tx = processedBet();

    expect(() =>
      tx.reject(FailureCode.InsufficientFunds),
    ).toThrow(InvalidTransactionStateError);

    expect(() =>
      tx.markProcessed(undefined, new Date()),
    ).toThrow(InvalidTransactionStateError);
  });

  test('deve rejeitar por saldo insuficiente', () => {
    const tx = createTransaction();

    tx.reject(FailureCode.InsufficientFunds);

    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(
      FailureCode.InsufficientFunds,
    );

    expect(tx.isTerminal()).toBe(true);
  });

  test('deve marcar falha permanente', () => {
    const tx = createTransaction();

    tx.fail(FailureCode.PermanentInfrastructureFailure);

    expect(tx.status).toBe(Status.Failed);
    expect(tx.isTerminal()).toBe(true);

    expect(() =>
      tx.reject(FailureCode.InvalidTransaction),
    ).toThrow(InvalidTransactionStateError);
  });

  test('REFUND exige referência', () => {
    expect(() =>
      createTransaction({
        kind: Kind.Refund,
      }),
    ).toThrow(InvalidWagerReferenceError);
  });

  test('ROLLBACK exige referência', () => {
    expect(() =>
      createTransaction({
        kind: Kind.Rollback,
      }),
    ).toThrow('REFERENCE_REQUIRED');
  });

  test('deve aguardar referência ausente', () => {
    const tx = createReversal(Kind.Refund);

    tx.markPendingReference();

    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.isTerminal()).toBe(false);
  });

  test('deve processar após encontrar referência', () => {
    const bet = processedBet();
    const refund = createReversal(Kind.Refund);

    refund.markPendingReference();

    expect(
      refund.ledgerDirectionFor(bet),
    ).toBe(LedgerDirection.Credit);

    refund.markProcessed(bet.id, new Date());

    expect(refund.status).toBe(Status.Processed);
    expect(refund.referenceTransactionId).toBe(bet.id);
  });

  test('deve rejeitar após referência expirar', () => {
    const tx = createReversal(Kind.Refund);

    tx.markPendingReference();
    tx.reject(FailureCode.ReferenceNotFound);

    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(
      FailureCode.ReferenceNotFound,
    );
  });

  test('deve identificar payload original', () => {
    const tx = createTransaction();

    expect(tx.matchesPayload(hash)).toBe(true);
    expect(tx.matchesPayload('b'.repeat(64))).toBe(false);
  });

  test('deve identificar operações sem saldo', () => {
    const loss = createTransaction({
      kind: Kind.Loss,
    });

    expect(loss.affectsBalance()).toBe(false);
    expect(loss.requiresReference()).toBe(false);
  });

  test('deve retornar direção de BET e WIN', () => {
    const bet = createTransaction();

    const win = createTransaction({
      id: 'win-1',
      externalTransactionId: 'win-1',
      kind: Kind.Win,
    });

    expect(bet.ledgerDirectionFor())
      .toBe(LedgerDirection.Debit);

    expect(win.ledgerDirectionFor())
      .toBe(LedgerDirection.Credit);
  });

  test('LOSS não deve criar ledger', () => {
    const loss = createTransaction({
      kind: Kind.Loss,
    });

    expect(() => loss.ledgerDirectionFor())
      .toThrow('LOSS_HAS_NO_LEDGER_ENTRY');
  });

  test('REFUND deve creditar uma BET', () => {
    const bet = processedBet();
    const refund = createReversal(Kind.Refund);

    expect(refund.ledgerDirectionFor(bet))
      .toBe(LedgerDirection.Credit);
  });

  test('ROLLBACK de BET deve creditar', () => {
    const bet = processedBet();
    const rollback = createReversal(Kind.Rollback);

    expect(rollback.ledgerDirectionFor(bet))
      .toBe(LedgerDirection.Credit);
  });

  test('ROLLBACK de WIN deve debitar', () => {
    const win = createTransaction({
      id: 'win-id',
      externalTransactionId: 'win-1',
      kind: Kind.Win,
      money: brl('50.00'),
    });

    win.markProcessed(undefined, new Date());

    const rollback = createReversal(Kind.Rollback, {
      referenceExternalTransactionId: 'win-1',
      money: brl('50.00'),
    });

    expect(rollback.ledgerDirectionFor(win))
      .toBe(LedgerDirection.Debit);
  });

  test('deve rejeitar valor diferente da referência', () => {
    const bet = processedBet();

    const refund = createReversal(Kind.Refund, {
      money: brl('20.00'),
    });

    expect(() =>
      refund.ledgerDirectionFor(bet),
    ).toThrow('REFERENCE_AMOUNT_MISMATCH');
  });

  test('deve rejeitar referência de outra wallet', () => {
    const bet = processedBet();

    const refund = createReversal(Kind.Refund, {
      walletId: 'wallet-2',
    });

    expect(() =>
      refund.ledgerDirectionFor(bet),
    ).toThrow('REFERENCE_MISMATCH');
  });

  test('deve rejeitar referência não processada', () => {
    const bet = createTransaction();
    const refund = createReversal(Kind.Refund);

    expect(() =>
      refund.ledgerDirectionFor(bet),
    ).toThrow('REFERENCE_NOT_PROCESSED');
  });

  test('deve rejeitar OPENING externa', () => {
    expect(() =>
      createTransaction({
        kind: Kind.Opening,
      }),
    ).toThrow(InvalidWagerTransactionError);
  });

  test('deve criar OPENING interna', () => {
    const opening = WagerTransaction.createOpening({
      id: 'opening-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      money: brl('100.00'),
      payloadHash: hash,
    });

    expect(opening.kind).toBe(Kind.Opening);
    expect(opening.status).toBe(Status.Pending);
    expect(opening.ledgerDirectionFor())
      .toBe(LedgerDirection.Credit);
  });

  test('deve rejeitar amount zero', () => {
    expect(() =>
      createTransaction({
        money: brl('0.00'),
      }),
    ).toThrow('INVALID_TRANSACTION_AMOUNT');
  });

  test('deve preservar data de processamento', () => {
    const tx = createTransaction();
    const date = new Date('2026-01-01T10:00:00Z');

    tx.markProcessed(undefined, date);

    date.setUTCFullYear(2000);

    const returnedDate = tx.processedAt!;
    returnedDate.setUTCFullYear(2001);

    expect(tx.processedAt!.getUTCFullYear())
      .toBe(2026);
  });

  test('deve reidratar estado persistido', () => {
    const original = processedBet();

    const restored = WagerTransaction.rehydrate({
      id: original.id,
      providerId: original.providerId,
      externalTransactionId:
        original.externalTransactionId,
      idempotencyKey: original.idempotencyKey,
      payloadHash: original.payloadHash,
      walletId: original.walletId,
      playerId: original.playerId,
      roundId: original.roundId,
      gameId: original.gameId,
      kind: original.kind,
      money: original.money,
      createdAt: original.createdAt,
      status: original.status,
      processedAt: original.processedAt,
    });

    expect(restored.status).toBe(Status.Processed);
    expect(restored.isTerminal()).toBe(true);

    expect(() =>
      restored.reject(FailureCode.InvalidTransaction),
    ).toThrow(InvalidTransactionStateError);
  });
});
