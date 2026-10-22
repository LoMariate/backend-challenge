import { Migration } from '@mikro-orm/migrations';

export class Migration20261022165927 extends Migration {

  override name = 'Migration20261022165927';

  override up(): void | Promise<void> {
    this.addSql(`create table "inbox_messages" ("id" uuid not null, "consumer_name" varchar(100) not null, "message_id" varchar(255) not null, "payload_hash" varchar(64) not null, "received_at" timestamptz not null, "processed_at" timestamptz null, primary key ("id"));`);
    this.addSql(`alter table "inbox_messages" add constraint "inbox_consumer_message_unique" unique ("consumer_name", "message_id");`);

    this.addSql(`alter table "wager_transactions" drop constraint "wager_kind_valid";`);
    this.addSql(`alter table "wager_transactions" drop constraint "wager_status_valid";`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_kind_valid" check (kind IN (
    'OPENING', 'BET', 'WIN',
    'LOSS', 'REFUND', 'ROLLBACK'
  ));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_status_valid" check (status IN (
    'PENDING', 'PENDING_REFERENCE',
    'PROCESSED', 'REJECTED', 'FAILED'
  ));`);

    this.addSql(`alter table "inbox_messages" add constraint "inbox_payload_hash_valid" check (payload_hash ~ '^[a-f0-9]{64}\$');`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "inbox_messages" cascade;`);

    this.addSql(`alter table "wager_transactions" drop constraint "wager_status_valid";`);
    this.addSql(`alter table "wager_transactions" drop constraint "wager_kind_valid";`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_status_valid" check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_kind_valid" check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'));`);
  }

}
