
import {
  Money,
  CurrencyMismatchError,
} from '../value-objects/money.js';

// Define o tipo de movimentação
export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

// Dados necessários para criar um lançamento
export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
}

// Estado que será reconstruído do banco
export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

// Erro de domínio para lançamentos inválidos
export class InvalidLedgerEntryError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'InvalidLedgerEntryError';
  }
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    private readonly _createdAt: Date,
  ) {
    Object.freeze(this);
  }

  // Cria um novo lançamento financeiro
  static create(
    props: CreateLedgerEntryProps,
  ): WalletLedgerEntry {
    const ids = [
      props.id,
      props.walletId,
      props.transactionId,
    ];

    if (
      ids.some(
        (id) =>
          typeof id !== 'string' ||
          id.trim().length === 0,
      )
    ) {
      throw new InvalidLedgerEntryError(
        'INVALID_LEDGER_IDENTIFIERS',
      );
    }

    // Valida a direção da operação
    if (
      props.direction !== LedgerDirection.Debit &&
      props.direction !== LedgerDirection.Credit
    ) {
      throw new InvalidLedgerEntryError(
        'INVALID_LEDGER_DIRECTION',
      );
    }

    // Todos os valores devem possuir a mesma moeda
    if (
      props.money.currency !== props.balanceBefore.currency ||
      props.money.currency !== props.balanceAfter.currency
    ) {
      throw new CurrencyMismatchError();
    }

    // Movimentações precisam ser positivas
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError(
        'INVALID_LEDGER_AMOUNT',
      );
    }

    // Nenhum saldo da carteira pode ser negativo
    if (
      props.balanceBefore.isNegative() ||
      props.balanceAfter.isNegative()
    ) {
      throw new InvalidLedgerEntryError(
        'NEGATIVE_LEDGER_BALANCE',
      );
    }

    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      new Date(props.createdAt?.getTime() ?? Date.now()),
    );

    // Verifica a consistência matemática
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        'UNBALANCED_LEDGER_ENTRY',
      );
    }

    return entry;
  }

  // Reconstrói um lançamento persistido
  // Não reexecuta as validações de criação
  static rehydrate(
    state: LedgerEntryState,
  ): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      new Date(state.createdAt.getTime()),
    );
  }

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  // Confere a equação do lançamento
  isBalanced(): boolean {
    if (
      this.money.currency !== this.balanceBefore.currency ||
      this.money.currency !== this.balanceAfter.currency
    ) {
      return false;
    }

    if (
      !this.money.isPositive() ||
      this.balanceBefore.isNegative() ||
      this.balanceAfter.isNegative()
    ) {
      return false;
    }

    let expectedBalance: Money;

    if (this.direction === LedgerDirection.Debit) {
      expectedBalance = this.balanceBefore.subtract(
        this.money,
      );
    } else if (this.direction === LedgerDirection.Credit) {
      expectedBalance = this.balanceBefore.add(
        this.money,
      );
    } else {
      return false;
    }

    return expectedBalance.equals(this.balanceAfter);
  }
}
