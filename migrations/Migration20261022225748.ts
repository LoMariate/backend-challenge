import { Migration } from '@mikro-orm/migrations';

export class Migration20261022225748 extends Migration {

  override name = 'Migration20261022225748';

  override up(): void | Promise<void> {
    this.addSql(`alter table "wager_transactions" drop constraint "wager_kind_valid";`);
    this.addSql(`alter table "wager_transactions" drop constraint "wager_status_valid";`);
    this.addSql(`alter table "wager_transactions" add "pending_reference_attempts" int not null default 0, add "next_reference_attempt_at" timestamptz null;`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_kind_valid" check (kind IN (
    'OPENING', 'BET', 'WIN',
    'LOSS', 'REFUND', 'ROLLBACK'
  ));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_status_valid" check (status IN (
    'PENDING', 'PENDING_REFERENCE',
    'PROCESSED', 'REJECTED', 'FAILED'
  ));`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "wager_transactions" drop constraint "wager_status_valid";`);
    this.addSql(`alter table "wager_transactions" drop constraint "wager_kind_valid";`);
    this.addSql(`alter table "wager_transactions" drop column "pending_reference_attempts", drop column "next_reference_attempt_at";`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_status_valid" check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_kind_valid" check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'));`);
  }

}
