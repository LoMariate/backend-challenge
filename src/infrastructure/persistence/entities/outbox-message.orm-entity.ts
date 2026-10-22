import {
  Entity,
  PrimaryKey,
  Property,
  Check,
  Index,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'outbox_messages' })

@Check({
  name: 'outbox_attempts_non_negative',
  expression: 'attempts >= 0',
})

@Index({
  name: 'outbox_publication_idx',
  properties: [
    'publishedAt',
    'nextAttemptAt',
    'occurredAt',
  ],
})


export class OutboxMessageOrmEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid' })
  aggregateId!: string;

  @Property({
    type: 'string',
    length: 100,
  })
  eventType!: string;

  @Property({ type: 'json' })
  payload!: Record<string, unknown>;

  @Property({
    type: 'datetime',
    columnType: 'timestamptz',
  })
  occurredAt!: Date;

  @Property({
    type: 'int',
    default: 0,
  })
  attempts!: number;

  @Property({
    type: 'datetime',
    columnType: 'timestamptz',
    nullable: true,
  })
  nextAttemptAt?: Date;

  @Property({
    type: 'datetime',
    columnType: 'timestamptz',
    nullable: true,
  })
  publishedAt?: Date;

  @Property({
    type: 'uuid',
    nullable: true,
  })
  claimToken?: string;

  @Property({
    type: 'datetime',
    columnType: 'timestamptz',
    nullable: true,
  })
  leaseUntil?: Date;

}
