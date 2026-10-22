import { Migration } from '@mikro-orm/migrations';

export class Migration20261022150202 extends Migration {

  override name = 'Migration20261022150202';

  override up(): void | Promise<void> {
    this.addSql(`alter table "wager_transactions" drop constraint "wager_reference_fk";`);
    this.addSql(`alter table "wager_transactions" drop constraint "wager_wallet_fk";`);

    this.addSql(`alter table "wallet_ledger_entries" drop constraint "ledger_transaction_fk";`);
    this.addSql(`alter table "wallet_ledger_entries" drop constraint "ledger_wallet_fk";`);

    this.addSql(`alter table "outbox_messages" add "claim_token" uuid null, add "lease_until" timestamptz null;`);

    this.addSql(`drop index "wager_processed_reversal_unique";`);
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

    this.addSql(`drop trigger if exists "ledger_block_update_delete" on "wallet_ledger_entries";`);
    this.addSql(`drop function if exists "wallet_ledger_entries_ledger_block_update_delete_fn"();`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "outbox_messages" drop column "claim_token", drop column "lease_until";`);

    this.addSql(`alter table "wager_transactions" drop constraint "wager_status_valid";`);
    this.addSql(`alter table "wager_transactions" drop constraint "wager_kind_valid";`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_reference_fk" foreign key ("reference_transaction_id") references "wager_transactions" ("id") on delete restrict;`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_wallet_fk" foreign key ("wallet_id") references "wallets" ("id") on delete restrict;`);
    this.addSql(`create unique index "wager_processed_reversal_unique" on "wager_transactions" ("reference_transaction_id", "kind") where ((status)::text = 'PROCESSED'::text) AND ((kind)::text = ANY ((ARRAY['REFUND'::character varying, 'ROLLBACK'::character varying])::text[]));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_status_valid" check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_kind_valid" check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'));`);

    this.addSql(`alter table "wallet_ledger_entries" add constraint "ledger_transaction_fk" foreign key ("transaction_id") references "wager_transactions" ("id") on delete restrict;`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "ledger_wallet_fk" foreign key ("wallet_id") references "wallets" ("id") on delete restrict;`);
    this.addSql(`create or replace function "wallet_ledger_entries_ledger_block_update_delete_fn"() returns trigger as \$\$ begin ; end; \$\$ language plpgsql;`);
    this.addSql(`create trigger "ledger_block_update_delete" BEFORE DELETE OR UPDATE on "wallet_ledger_entries" for each ROW execute function "wallet_ledger_entries_ledger_block_update_delete_fn"();`);
  }

}
