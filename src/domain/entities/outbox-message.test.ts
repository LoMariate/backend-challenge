
import { describe, expect, test } from 'bun:test';

import {
  IntegrationEvent,
} from '../events/integration-event.js';

import {
  OutboxMessage,
} from './outbox-message.js';

// Evento simples para testar o comportamento da Outbox
class TestEvent extends IntegrationEvent<{
  amount: string;
}> {
  readonly eventType = 'TestEvent';
  readonly version = 1;

  constructor() {
    super({
      eventId: 'event-123',
      aggregateId: 'wallet-123',
      correlationId: 'transaction-123',
      occurredAt: new Date('2026-01-01T10:00:00Z'),
      data: {
        amount: '100.00',
      },
    });
  }
}

describe('OutboxMessage', () => {
  test('deve criar evento pendente', () => {
    const message = OutboxMessage.enqueue(
      new TestEvent(),
    );

    expect(message.id).toBe('event-123');
    expect(message.eventType).toBe('TestEvent');
    expect(message.isPending()).toBe(true);
    expect(message.attempts).toBe(0);

    expect(message.payload).toMatchObject({
      eventId: 'event-123',
      eventType: 'TestEvent',
      version: 1,
      data: {
        amount: '100.00',
      },
    });
  });

  test('deve agendar retry exponencial', () => {
    const message = OutboxMessage.enqueue(
      new TestEvent(),
    );

    const now = new Date('2026-01-01T10:00:00Z');

    message.scheduleRetry(now);

    expect(message.attempts).toBe(1);
    expect(message.isDue(now)).toBe(false);

    const later = new Date(
      now.getTime() + 1000,
    );

    expect(message.isDue(later)).toBe(true);
  });

  test('deve marcar evento como publicado', () => {
    const message = OutboxMessage.enqueue(
      new TestEvent(),
    );

    message.markPublished(new Date());

    expect(message.isPending()).toBe(false);
    expect(message.publishedAt).toBeDefined();

    expect(() =>
      message.markPublished(new Date()),
    ).toThrow('OUTBOX_ALREADY_PUBLISHED');
  });
});
