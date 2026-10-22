import { Migration } from '@mikro-orm/migrations';

export class Migration20261022123414 extends Migration {

  override name = 'Migration20261022123414';

  override up(): void | Promise<void> {
    this.addSql(`create table "wager_transactions" ("id" uuid not null, "provider_id" varchar(100) not null, "external_transaction_id" varchar(255) not null, "idempotency_key" varchar(255) not null, "payload_hash" varchar(64) not null, "wallet_id" uuid not null, "player_id" uuid not null, "round_id" varchar(255) not null, "game_id" varchar(255) not null, "kind" varchar(16) not null, "amount" numeric(20,2) not null, "currency" varchar(3) not null, "reference_external_transaction_id" varchar(255) null, "reference_transaction_id" uuid null, "status" varchar(24) not null default 'PENDING', "failure_code" varchar(100) null, "observed_balance" numeric(20,2) null, "created_at" timestamptz not null, "processed_at" timestamptz null, primary key ("id"));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_provider_idempotency_unique" unique ("provider_id", "idempotency_key");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_provider_external_unique" unique ("provider_id", "external_transaction_id");`);

    this.addSql(`create table "wallet_ledger_entries" ("id" uuid not null, "wallet_id" uuid not null, "transaction_id" uuid not null, "direction" varchar(6) not null, "amount" numeric(20,2) not null, "currency" varchar(3) not null, "balance_before" numeric(20,2) not null, "balance_after" numeric(20,2) not null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "ledger_wallet_transaction_unique" unique ("wallet_id", "transaction_id");`);

    this.addSql(`
      ALTER TABLE wager_transactions
      ADD CONSTRAINT wager_wallet_fk
      FOREIGN KEY (wallet_id)
      REFERENCES wallets(id)
      ON DELETE RESTRICT;
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
      ADD CONSTRAINT wager_reference_fk
      FOREIGN KEY (reference_transaction_id)
      REFERENCES wager_transactions(id)
      ON DELETE RESTRICT;
    `);

    this.addSql(`
      ALTER TABLE wallet_ledger_entries
      ADD CONSTRAINT ledger_wallet_fk
      FOREIGN KEY (wallet_id)
      REFERENCES wallets(id)
      ON DELETE RESTRICT;
    `);

    this.addSql(`
      ALTER TABLE wallet_ledger_entries
      ADD CONSTRAINT ledger_transaction_fk
      FOREIGN KEY (transaction_id)
      REFERENCES wager_transactions(id)
      ON DELETE RESTRICT;
    `);


    this.addSql(`alter table "wager_transactions" add constraint "wager_observed_balance_valid" check (observed_balance IS NULL OR observed_balance >= 0);`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_failure_code_required" check (status NOT IN ('REJECTED', 'FAILED')
    OR failure_code IS NOT NULL);`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_reference_required" check (kind NOT IN ('REFUND', 'ROLLBACK')
    OR reference_external_transaction_id IS NOT NULL);`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_status_valid" check (status IN (
    'PENDING', 'PENDING_REFERENCE',
    'PROCESSED', 'REJECTED', 'FAILED'
  ));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_kind_valid" check (kind IN (
    'OPENING', 'BET', 'WIN',
    'LOSS', 'REFUND', 'ROLLBACK'
  ));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_currency_format" check (currency ~ '^[A-Z]{3}\$');`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_amount_positive" check (amount > 0);`);

    this.addSql(`alter table "wallet_ledger_entries" add constraint "ledger_arithmetic_valid" check ((
    direction = 'CREDIT'
    AND balance_after = balance_before + amount
  ) OR (
    direction = 'DEBIT'
    AND balance_after = balance_before - amount
  ));`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "ledger_currency_format" check (currency ~ '^[A-Z]{3}\$');`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "ledger_balances_non_negative" check (balance_before >= 0 AND balance_after >= 0);`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "ledger_amount_positive" check (amount > 0);`);

    // Impendimento de duas reversoes da mesma transacao    
    this.addSql(`
      CREATE UNIQUE INDEX wager_processed_reversal_unique
      ON wager_transactions (
        reference_transaction_id,
        kind
      )
      WHERE status = 'PROCESSED'
        AND kind IN ('REFUND', 'ROLLBACK');
    `);

    // Garantir que o ledger seja imutavel    
    this.addSql(`
      CREATE FUNCTION prevent_ledger_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'LEDGER_IS_IMMUTABLE';
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
    `);

    this.addSql(`
      CREATE TRIGGER ledger_block_update_delete
      BEFORE UPDATE OR DELETE
      ON wallet_ledger_entries
      FOR EACH ROW
      EXECUTE FUNCTION prevent_ledger_mutation();
    `);

    this.addSql(`
      CREATE TRIGGER ledger_block_truncate
      BEFORE TRUNCATE
      ON wallet_ledger_entries
      FOR EACH STATEMENT
      EXECUTE FUNCTION prevent_ledger_mutation();
    `);

  }

  override down(): void | Promise<void> {
    
    this.addSql(`
      DROP TRIGGER IF EXISTS ledger_block_update_delete
      ON wallet_ledger_entries;
    `);

    this.addSql(`
      DROP TRIGGER IF EXISTS ledger_block_truncate
      ON wallet_ledger_entries;
    `);

    this.addSql(`
      DROP FUNCTION IF EXISTS prevent_ledger_mutation();
    `);

    this.addSql(`
      DROP INDEX IF EXISTS wager_processed_reversal_unique;
    `);

    this.addSql(`
      ALTER TABLE wallet_ledger_entries
      DROP CONSTRAINT IF EXISTS ledger_transaction_fk;
    `);

    this.addSql(`
      ALTER TABLE wallet_ledger_entries
      DROP CONSTRAINT IF EXISTS ledger_wallet_fk;
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
      DROP CONSTRAINT IF EXISTS wager_reference_fk;
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
      DROP CONSTRAINT IF EXISTS wager_wallet_fk;
    `);

    this.addSql(`drop table if exists "wager_transactions" cascade;`);
    this.addSql(`drop table if exists "wallet_ledger_entries" cascade;`);
  }

}
