import { Decimal } from 'decimal.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class InvalidMoneyAmountError extends Error {
  constructor() {
    super('INVALID_MONEY_AMOUNT');
    this.name = 'InvalidMoneyAmountError';
  }
}

export class InvalidCurrencyError extends Error {
  constructor() {
    super('INVALID_CURRENCY');
    this.name = 'InvalidCurrencyError';
  }
}

export class CurrencyMismatchError extends Error {
  constructor() {
    super('CURRENCY_MISMATCH');
    this.name = 'CurrencyMismatchError';
  }
}

export class Money {
  private static readonly AMOUNT_REGEX =
    /^(0|[1-9]\d*)\.\d{2}$/;

  private static readonly CURRENCY_REGEX =
    /^[A-Z]{3}$/;

  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  // Cria um Money a partir de dados externos
  static from(props: MoneyProps): Money {
    if (
      typeof props?.amount !== 'string' ||
      !Money.AMOUNT_REGEX.test(props.amount)
    ) {
      throw new InvalidMoneyAmountError();
    }

    if (
      typeof props.currency !== 'string' ||
      !Money.CURRENCY_REGEX.test(props.currency)
    ) {
      throw new InvalidCurrencyError();
    }

    return new Money(
      new Decimal(props.amount),
      props.currency,
    );
  }

  // Cria um valor monetário zero
  static zero(currency: string): Money {
    return Money.from({
      amount: '0.00',
      currency,
    });
  }

  // Soma dois valores
  add(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(
      this.value.plus(other.value),
      this.currency,
    );
  }

  // Subtrai dois valores
  subtract(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(
      this.value.minus(other.value),
      this.currency,
    );
  }

  // Inverte o sinal
  negate(): Money {
    return new Money(
      this.value.negated(),
      this.currency,
    );
  }

  // Verifica se é zero
  isZero(): boolean {
    return this.value.isZero();
  }

  // Verifica se é positivo
  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  // Verifica se é negativo
  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  // Compara se é menor que outro valor
  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.lessThan(other.value);
  }

  // Verifica igualdade
  equals(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.equals(other.value);
  }

  // Serializa para contratos e respostas JSON
  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  // Representação textual
  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  // Impede operações entre moedas diferentes
  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError();
    }
  }
}