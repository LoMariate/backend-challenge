import { DecimalType } from '@mikro-orm/core';

import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
  Check,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wager_transactions' })

// Uma transação externa por provedor
@Unique({
  name: 'wager_provider_external_unique',
  properties: ['providerId', 'externalTransactionId'],
})

// Uma idempotency key por provedor
@Unique({
  name: 'wager_provider_idempotency_unique',
  properties: ['providerId', 'idempotencyKey'],
})

@Check({
  name: 'wager_amount_positive',
  expression: 'amount > 0',
})

@Check({
  name: 'wager_currency_format',
  expression: "currency ~ '^[A-Z]{3}$'",
})

@Check({
  name: 'wager_kind_valid',
  expression: `kind IN (
    'OPENING', 'BET', 'WIN',
    'LOSS', 'REFUND', 'ROLLBACK'
  )`,
})

@Check({
  name: 'wager_status_valid',
  expression: `status IN (
    'PENDING', 'PENDING_REFERENCE',
    'PROCESSED', 'REJECTED', 'FAILED'
  )`,
})

@Check({
  name: 'wager_reference_required',
  expression: `kind NOT IN ('REFUND', 'ROLLBACK')
    OR reference_external_transaction_id IS NOT NULL`,
})

@Check({
  name: 'wager_failure_code_required',
  expression: `status NOT IN ('REJECTED', 'FAILED')
    OR failure_code IS NOT NULL`,
})

@Check({
  name: 'wager_observed_balance_valid',
  expression: 'observed_balance IS NULL OR observed_balance >= 0',
})

export class WagerTransactionOrmEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'string', length: 100 })
  providerId!: string;

  @Property({ type: 'string', length: 255 })
  externalTransactionId!: string;

  @Property({ type: 'string', length: 255 })
  idempotencyKey!: string;

  @Property({ type: 'string', length: 64 })
  payloadHash!: string;

  @Property({ type: 'uuid' })
  walletId!: string;

  @Property({ type: 'uuid' })
  playerId!: string;

  @Property({ type: 'string', length: 255 })
  roundId!: string;

  @Property({ type: 'string', length: 255 })
  gameId!: string;

  @Property({ type: 'string', length: 16 })
  kind!: string;

  @Property({
    type: DecimalType,
    precision: 20,
    scale: 2,
  })
  amount!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({
    type: 'string',
    length: 255,
    nullable: true,
  })
  referenceExternalTransactionId?: string;

  @Property({ type: 'uuid', nullable: true })
  referenceTransactionId?: string;

  @Property({
    type: 'string',
    length: 24,
    default: 'PENDING',
  })
  status!: string;

  @Property({
    type: 'string',
    length: 100,
    nullable: true,
  })
  failureCode?: string;

  // Saldo observado quando a operação foi decidida.
  // Necessário para replay idempotente.
  @Property({
    type: DecimalType,
    precision: 20,
    scale: 2,
    nullable: true,
  })
  observedBalance?: string;

  @Property({
    type: 'datetime',
    columnType: 'timestamptz',
  })
  createdAt!: Date;

  @Property({
    type: 'datetime',
    columnType: 'timestamptz',
    nullable: true,
  })
  processedAt?: Date;
  
  @Property({
    type: 'int',
    default: 0,
  })
  pendingReferenceAttempts!: number;

  @Property({
    type: 'datetime',
    columnType: 'timestamptz',
    nullable: true,
  })
  nextReferenceAttemptAt?: Date;
}
