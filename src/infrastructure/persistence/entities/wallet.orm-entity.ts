import { DecimalType } from '@mikro-orm/core';

import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
  Check,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wallets' })
@Unique({
  name: 'wallet_player_currency_unique',
  properties: ['playerId', 'currency'],
})
@Check({
  name: 'wallet_balance_non_negative',
  expression: 'balance >= 0',
})
@Check({
  name: 'wallet_version_positive',
  expression: 'version >= 1',
})
@Check({
  name: 'wallet_currency_format',
  expression: "currency ~ '^[A-Z]{3}$'",
})
export class WalletOrmEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({
    type: 'uuid',
    fieldName: 'player_id',
  })
  playerId!: string;

  @Property({
    type: 'string',
    length: 3,
  })
  currency!: string;

  @Property({
    type: DecimalType,
    precision: 20,
    scale: 2,
  })
  balance!: string;

  @Property({
    type: 'int',
    default: 1,
  })
  version!: number;

  @Property({
    type: 'datetime',
    columnType: 'timestamptz',
  })
  createdAt!: Date;

  @Property({
    type: 'datetime',
    columnType: 'timestamptz',
  })
  updatedAt!: Date;
}
