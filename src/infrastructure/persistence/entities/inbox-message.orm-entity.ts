import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
  Check,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'inbox_messages' })
@Unique({
  name: 'inbox_consumer_message_unique',
  properties: ['consumerName', 'messageId'],
})
@Check({
  name: 'inbox_payload_hash_valid',
  expression: "payload_hash ~ '^[a-f0-9]{64}$'",
})
export class InboxMessageOrmEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({
    type: 'string',
    length: 100,
  })
  consumerName!: string;

  @Property({
    type: 'string',
    length: 255,
  })
  messageId!: string;

  @Property({
    type: 'string',
    length: 64,
  })
  payloadHash!: string;

  @Property({
    type: 'datetime',
    columnType: 'timestamptz',
  })
  receivedAt!: Date;

  @Property({
    type: 'datetime',
    columnType: 'timestamptz',
    nullable: true,
  })
  processedAt?: Date;
}
