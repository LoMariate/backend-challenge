import { IntegrationEvent } from
  '../events/integration-event.js';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload:
      Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue<T extends object>(
    event: IntegrationEvent<T>,
  ): OutboxMessage {
    const payload = event.toJSON();

    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      Object.freeze({ ...payload }),
      new Date(event.occurredAt),
      0,
    );
  }

  static rehydrate(
    state: OutboxMessageState,
  ): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      Object.freeze({ ...state.payload }),
      new Date(state.occurredAt),
      state.attempts,
      state.nextAttemptAt
        ? new Date(state.nextAttemptAt)
        : undefined,
      state.publishedAt
        ? new Date(state.publishedAt)
        : undefined,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt
      ? new Date(this._nextAttemptAt)
      : undefined;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt
      ? new Date(this._publishedAt)
      : undefined;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      (
        this._nextAttemptAt === undefined ||
        this._nextAttemptAt.getTime() <= now.getTime()
      )
    );
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new Error('OUTBOX_ALREADY_PUBLISHED');
    }

    this._publishedAt = new Date(at);
    this._nextAttemptAt = undefined;
  }

  scheduleRetry(now: Date): void {
    if (!this.isPending()) {
      throw new Error('OUTBOX_ALREADY_PUBLISHED');
    }

    this._attempts += 1;

    // Backoff exponencial, limitado a 5 minutos
    const delay = Math.min(
      1000 * 2 ** Math.min(this._attempts - 1, 10),
      300000,
    );

    this._nextAttemptAt = new Date(
      now.getTime() + delay,
    );
  }
}
