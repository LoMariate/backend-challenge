import { describe, expect, test } from 'bun:test';

import {
  InboxMessage,
  InvalidInboxMessageError,
} from './inbox-message.js';

const hash = 'a'.repeat(64);

const createInbox = (): InboxMessage =>
  InboxMessage.receive({
    consumerName: 'wager-consumer',
    messageId: 'msg-123',
    payloadHash: hash,
  });

describe('InboxMessage', () => {
  test('deve criar uma mensagem não processada', () => {
    const inbox = createInbox();

    expect(inbox.messageId).toBe('msg-123');
    expect(inbox.consumerName).toBe('wager-consumer');
    expect(inbox.isProcessed()).toBe(false);
  });

  test('deve marcar mensagem como processada', () => {
    const inbox = createInbox();

    inbox.markProcessed(
      new Date('2026-01-01T10:00:00Z'),
    );

    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt).toBeDefined();
  });

  test('não deve processar duas vezes', () => {
    const inbox = createInbox();

    inbox.markProcessed(new Date());

    expect(() =>
      inbox.markProcessed(new Date()),
    ).toThrow(InvalidInboxMessageError);
  });

  test('deve detectar payload diferente', () => {
    const inbox = createInbox();

    expect(inbox.matchesPayload(hash)).toBe(true);

    expect(
      inbox.matchesPayload('b'.repeat(64)),
    ).toBe(false);
  });

  test('deve rejeitar identificador vazio', () => {
    expect(() =>
      InboxMessage.receive({
        consumerName: 'wager-consumer',
        messageId: '',
        payloadHash: hash,
      }),
    ).toThrow('INVALID_INBOX_IDENTIFIERS');
  });

  test('deve reidratar mensagem processada', () => {
    const inbox = InboxMessage.rehydrate({
      consumerName: 'wager-consumer',
      messageId: 'msg-123',
      payloadHash: hash,
      receivedAt: new Date('2026-01-01T09:00:00Z'),
      processedAt: new Date('2026-01-01T10:00:00Z'),
    });

    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt?.toISOString())
      .toBe('2026-01-01T10:00:00.000Z');
  });
});
