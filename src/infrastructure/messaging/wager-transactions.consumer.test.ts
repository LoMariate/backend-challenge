import { describe, expect, test } from 'bun:test';

import {
  parseWagerMessage,
} from './wager-transactions.consumer.js';

const validMessage = {
  messageId: 'msg-123',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-10-22T10:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'bet-123',
    idempotencyKey: 'provider-a:bet-123',
    playerId: 'player-123',
    walletId: 'wallet-123',
    roundId: 'round-123',
    gameId: 'game-123',
    kind: 'BET',
    money: {
      amount: '25.00',
      currency: 'BRL',
    },
  },
};

describe('SQS Wager Message Parser', () => {
  test('aceita BET válida', () => {
    const result = parseWagerMessage(
      JSON.stringify(validMessage),
    );

    expect(result.data.kind).toBe('BET');
    expect(result.data.money.amount).toBe('25.00');
  });

  test('rejeita OPENING externa', () => {
    const message = {
      ...validMessage,
      data: {
        ...validMessage.data,
        kind: 'OPENING',
      },
    };

    expect(() =>
      parseWagerMessage(JSON.stringify(message)),
    ).toThrow('INVALID_TRANSACTION_KIND');
  });

  test('rejeita dinheiro inválido', () => {
    const message = {
      ...validMessage,
      data: {
        ...validMessage.data,
        money: {
          amount: '25.123',
          currency: 'BRL',
        },
      },
    };

    expect(() =>
      parseWagerMessage(JSON.stringify(message)),
    ).toThrow();
  });
});
