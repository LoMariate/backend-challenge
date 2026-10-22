export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt?: Date;
}

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

export class InvalidInboxMessageError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'InvalidInboxMessageError';
  }
}

export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    private readonly _receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    if (
      !props.messageId?.trim() ||
      !props.consumerName?.trim()
    ) {
      throw new InvalidInboxMessageError(
        'INVALID_INBOX_IDENTIFIERS',
      );
    }

    if (!/^[a-f0-9]{64}$/.test(props.payloadHash)) {
      throw new InvalidInboxMessageError(
        'INVALID_INBOX_PAYLOAD_HASH',
      );
    }

    const receivedAt = props.receivedAt
      ? new Date(props.receivedAt)
      : new Date();

    if (Number.isNaN(receivedAt.getTime())) {
      throw new InvalidInboxMessageError(
        'INVALID_RECEIVED_AT',
      );
    }

    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      receivedAt,
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      new Date(state.receivedAt),
      state.processedAt
        ? new Date(state.processedAt)
        : undefined,
    );
  }

  get receivedAt(): Date {
    return new Date(this._receivedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt
      ? new Date(this._processedAt)
      : undefined;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  matchesPayload(hash: string): boolean {
    return this.payloadHash === hash;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvalidInboxMessageError(
        'INBOX_ALREADY_PROCESSED',
      );
    }

    if (Number.isNaN(at.getTime())) {
      throw new InvalidInboxMessageError(
        'INVALID_PROCESSED_AT',
      );
    }

    this._processedAt = new Date(at);
  }
}
