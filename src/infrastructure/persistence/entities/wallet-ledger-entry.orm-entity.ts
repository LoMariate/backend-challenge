import { DecimalType } from '@mikro-orm/core';

import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
  Check,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wallet_ledger_entries' })

// Uma transação financeira produz no máximo
// um lançamento por wallet.
@Unique({
  name: 'ledger_wallet_transaction_unique',
  properties: ['walletId', 'transactionId'],
})

@Check({
  name: 'ledger_amount_positive',
  expression: 'amount > 0',
})

@Check({
  name: 'ledger_balances_non_negative',
  expression: 'balance_before >= 0 AND balance_after >= 0',
})

@Check({
  name: 'ledger_currency_format',
  expression: "currency ~ '^[A-Z]{3}$'",
})

// Confere a equação financeira diretamente no banco.
@Check({
  name: 'ledger_arithmetic_valid',
  expression: `(
    direction = 'CREDIT'
    AND balance_after = balance_before + amount
  ) OR (
    direction = 'DEBIT'
    AND balance_after = balance_before - amount
  )`,
})

export class WalletLedgerEntryOrmEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid' })
  walletId!: string;

  @Property({ type: 'uuid' })
  transactionId!: string;

  @Property({ type: 'string', length: 6 })
  direction!: string;

  @Property({
    type: DecimalType,
    precision: 20,
    scale: 2,
  })
  amount!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({
    type: DecimalType,
    precision: 20,
    scale: 2,
  })
  balanceBefore!: string;

  @Property({
    type: DecimalType,
    precision: 20,
    scale: 2,
  })
  balanceAfter!: string;

  @Property({
    type: 'datetime',
    columnType: 'timestamptz',
  })
  createdAt!: Date;
}
