
import {
  Money,
  CurrencyMismatchError,
} from '../value-objects/money.js';

// Representa os dados já persistidos de uma carteira
export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

// Resultado de uma movimentação financeira
export interface WalletMovement {
  readonly direction: 'DEBIT' | 'CREDIT';
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
}

export class InsufficientFundsError extends Error {
  constructor() {
    super('INSUFFICIENT_FUNDS');
    this.name = 'InsufficientFundsError';
  }
}

export class InvalidWalletAmountError extends Error {
  constructor() {
    super('INVALID_WALLET_AMOUNT');
    this.name = 'InvalidWalletAmountError';
  }
}

export class InvalidInitialBalanceError extends Error {
  constructor() {
    super('INVALID_INITIAL_BALANCE');
    this.name = 'InvalidInitialBalanceError';
  }
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    private readonly _createdAt: Date,
    private _updatedAt: Date,
  ) {}

  // Abre uma nova carteira
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
  }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidInitialBalanceError();
    }

    const now = new Date();

    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  // Reconstrói uma carteira já salva no banco
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt),
      new Date(state.updatedAt),
    );
  }

  // Permite consultar o saldo, sem alterá-lo
  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt);
  }

  // Debita dinheiro da carteira
  debit(amount: Money, at: Date = new Date()): WalletMovement {
    this.assertSameCurrency(amount);
    this.assertPositiveAmount(amount);

    if (this._balance.isLessThan(amount)) {
      throw new InsufficientFundsError();
    }

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.subtract(amount);

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = new Date(at);

    return {
      direction: 'DEBIT',
      money: amount,
      balanceBefore,
      balanceAfter,
    };
  }

  // Credita dinheiro na carteira
  credit(amount: Money, at: Date = new Date()): WalletMovement {
    this.assertSameCurrency(amount);
    this.assertPositiveAmount(amount);

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.add(amount);

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = new Date(at);

    return {
      direction: 'CREDIT',
      money: amount,
      balanceBefore,
      balanceAfter,
    };
  }

  // Garante que a moeda corresponde à carteira
  private assertSameCurrency(amount: Money): void {
    if (this.currency !== amount.currency) {
      throw new CurrencyMismatchError();
    }
  }

  // Impede movimentações com valor zero ou negativo
  private assertPositiveAmount(amount: Money): void {
    if (!amount.isPositive()) {
      throw new InvalidWalletAmountError();
    }
  }
}
