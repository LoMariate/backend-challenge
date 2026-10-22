import { LedgerDirection } from './wallet-ledger-entry.js';
import { Money } from '../value-objects/money.js';

// Tipos de operação
export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

// Estados da transação
export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

// Códigos de falha estáveis
export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  InvalidReference = 'INVALID_REFERENCE',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  InvalidTransaction = 'INVALID_TRANSACTION',
  PermanentInfrastructureFailure =
    'PERMANENT_INFRASTRUCTURE_FAILURE',
}

// Dados necessários para criar uma transação
export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

// Dados para o crédito interno de abertura
export interface CreateOpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  payloadHash: string;
  createdAt?: Date;
}

// Estado reconstruído da persistência
export type WagerTransactionState =
  Omit<CreateWagerTransactionProps, 'createdAt'> & {
    createdAt: Date;
    status: WagerTransactionStatus;
    referenceTransactionId?: string;
    failureCode?: FailureCode;
    processedAt?: Date;
  };

// Erros de domínio
export class InvalidWagerTransactionError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'InvalidWagerTransactionError';
  }
}

export class InvalidTransactionStateError extends Error {
  constructor(
    status: WagerTransactionStatus,
    action: string,
  ) {
    super(`INVALID_STATE:${status}:${action}`);
    this.name = 'InvalidTransactionStateError';
  }
}

export class InvalidWagerReferenceError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'InvalidWagerReferenceError';
  }
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId:
      string | undefined,
    private readonly _createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  // Cria uma transação recebida pela API ou fila
  static create(
    props: CreateWagerTransactionProps,
  ): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError(
        'OPENING_IS_INTERNAL',
      );
    }

    return WagerTransaction.build(props);
  }

  // Factory utilizada apenas no caso de uso interno
  // de abertura de uma wallet
  static createOpening(
    props: CreateOpeningTransactionProps,
  ): WagerTransaction {
    return WagerTransaction.build({
      id: props.id,
      providerId: 'internal',
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: `internal:opening:${props.walletId}`,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: `opening:${props.walletId}`,
      gameId: 'wallet-opening',
      kind: WagerTransactionKind.Opening,
      money: props.money,
      createdAt: props.createdAt,
    });
  }

  // Valida a criação de uma transação nova
  private static build(
    props: CreateWagerTransactionProps,
  ): WagerTransaction {
    const identifiers = [
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
    ];

    if (
      identifiers.some(
        (value) =>
          typeof value !== 'string' ||
          value.trim().length === 0,
      )
    ) {
      throw new InvalidWagerTransactionError(
        'INVALID_TRANSACTION_IDENTIFIERS',
      );
    }

    if (
      typeof props.payloadHash !== 'string' ||
      !/^[a-fA-F0-9]{64}$/.test(props.payloadHash)
    ) {
      throw new InvalidWagerTransactionError(
        'INVALID_PAYLOAD_HASH',
      );
    }

    if (
      !Object.values(WagerTransactionKind).includes(
        props.kind,
      )
    ) {
      throw new InvalidWagerTransactionError(
        'INVALID_TRANSACTION_KIND',
      );
    }

    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError(
        'INVALID_TRANSACTION_AMOUNT',
      );
    }

    const reference = props.referenceExternalTransactionId;

    if (
      reference !== undefined &&
      (typeof reference !== 'string' ||
        reference.trim().length === 0)
    ) {
      throw new InvalidWagerReferenceError(
        'INVALID_REFERENCE',
      );
    }

    const requiresReference =
      props.kind === WagerTransactionKind.Refund ||
      props.kind === WagerTransactionKind.Rollback;

    if (requiresReference && !reference) {
      throw new InvalidWagerReferenceError(
        'REFERENCE_REQUIRED',
      );
    }

    if (
      reference &&
      (props.kind === WagerTransactionKind.Bet ||
        props.kind === WagerTransactionKind.Loss ||
        props.kind === WagerTransactionKind.Opening)
    ) {
      throw new InvalidWagerReferenceError(
        'UNEXPECTED_REFERENCE',
      );
    }

    if (
      reference &&
      reference === props.externalTransactionId
    ) {
      throw new InvalidWagerReferenceError(
        'SELF_REFERENCE_NOT_ALLOWED',
      );
    }

    const createdAt = props.createdAt
      ? new Date(props.createdAt.getTime())
      : new Date();

    if (Number.isNaN(createdAt.getTime())) {
      throw new InvalidWagerTransactionError(
        'INVALID_CREATED_AT',
      );
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      reference,
      createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  // Reconstitui estado já persistido
  // Não revalida as regras de criação/transição
  static rehydrate(
    state: WagerTransactionState,
  ): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      new Date(state.createdAt),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt
        ? new Date(state.processedAt)
        : undefined,
    );
  }

  // Getters
  get status(): WagerTransactionStatus {
    return this._status;
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt
      ? new Date(this._processedAt)
      : undefined;
  }

  // Marca a transação como processada
  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
  ): void {
    this.assertCanTransition('markProcessed');

    if (
      this.referenceExternalTransactionId &&
      (!referenceTransactionId ||
        referenceTransactionId.trim().length === 0)
    ) {
      throw new InvalidWagerReferenceError(
        'REFERENCE_ID_REQUIRED',
      );
    }

    if (
      !this.referenceExternalTransactionId &&
      referenceTransactionId !== undefined
    ) {
      throw new InvalidWagerReferenceError(
        'UNEXPECTED_REFERENCE_ID',
      );
    }

    if (Number.isNaN(at.getTime())) {
      throw new InvalidWagerTransactionError(
        'INVALID_PROCESSED_AT',
      );
    }

    this._referenceTransactionId =
      referenceTransactionId;

    this._processedAt = new Date(at);
    this._failureCode = undefined;
    this._status = WagerTransactionStatus.Processed;
  }

  // Referência ainda não está disponível
  markPendingReference(): void {
    this.assertCanTransition('markPendingReference');

    if (!this.referenceExternalTransactionId) {
      throw new InvalidWagerReferenceError(
        'REFERENCE_REQUIRED',
      );
    }

    this._status = WagerTransactionStatus.PendingReference;
  }

  // Rejeição por regra de negócio
  reject(code: FailureCode): void {
    this.assertCanTransition('reject');

    this._failureCode = code;
    this._status = WagerTransactionStatus.Rejected;
  }

  // Falha permanente e auditável
  fail(code: FailureCode): void {
    this.assertCanTransition('fail');

    this._failureCode = code;
    this._status = WagerTransactionStatus.Failed;
  }

  // Verifica se o estado é terminal
  isTerminal(): boolean {
    return [
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
      WagerTransactionStatus.Failed,
    ].includes(this._status);
  }

  // Verifica se a operação altera o saldo
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  // Verifica se exige uma operação referenciada
  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  // Confere o hash da operação original
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  // Identifica a direção financeira da operação
  ledgerDirectionFor(
    reference?: WagerTransaction,
  ): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Bet:
        return this.kind === WagerTransactionKind.Bet
          ? LedgerDirection.Debit
          : LedgerDirection.Credit;

      case WagerTransactionKind.Win:
        if (this.referenceExternalTransactionId) {
          this.assertValidReference(
            reference,
            [WagerTransactionKind.Bet],
            false,
          );
        } else if (reference) {
          throw new InvalidWagerReferenceError(
            'UNEXPECTED_REFERENCE',
          );
        }

        return LedgerDirection.Credit;

      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError(
          'LOSS_HAS_NO_LEDGER_ENTRY',
        );

      case WagerTransactionKind.Refund:
        this.assertValidReference(
          reference,
          [WagerTransactionKind.Bet],
          true,
        );

        return LedgerDirection.Credit;

      case WagerTransactionKind.Rollback:
        this.assertValidReference(
          reference,
          [
            WagerTransactionKind.Bet,
            WagerTransactionKind.Win,
            WagerTransactionKind.Refund,
          ],
          true,
        );

        return reference!.kind === WagerTransactionKind.Bet
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
    }
  }

  // Valida a referência resolvida pelo caso de uso
  private assertValidReference(
    reference: WagerTransaction | undefined,
    allowedKinds: readonly WagerTransactionKind[],
    requireSameAmount: boolean,
  ): void {
    if (!reference) {
      throw new InvalidWagerReferenceError(
        'REFERENCE_REQUIRED',
      );
    }

    if (
      !this.referenceExternalTransactionId ||
      this.referenceExternalTransactionId !==
        reference.externalTransactionId ||
      this.id === reference.id
    ) {
      throw new InvalidWagerReferenceError(
        'INVALID_REFERENCE',
      );
    }

    if (
      reference.status !==
      WagerTransactionStatus.Processed
    ) {
      throw new InvalidWagerReferenceError(
        'REFERENCE_NOT_PROCESSED',
      );
    }

    if (!allowedKinds.includes(reference.kind)) {
      throw new InvalidWagerReferenceError(
        'INVALID_REFERENCE_KIND',
      );
    }

    if (
      this.providerId !== reference.providerId ||
      this.playerId !== reference.playerId ||
      this.walletId !== reference.walletId ||
      this.roundId !== reference.roundId ||
      this.money.currency !== reference.money.currency
    ) {
      throw new InvalidWagerReferenceError(
        'REFERENCE_MISMATCH',
      );
    }

    if (
      requireSameAmount &&
      !this.money.equals(reference.money)
    ) {
      throw new InvalidWagerReferenceError(
        'REFERENCE_AMOUNT_MISMATCH',
      );
    }
  }

  // Impede alterações em estados terminais
  private assertCanTransition(action: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        this._status,
        action,
      );
    }
  }
}
