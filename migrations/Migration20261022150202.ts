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
    // 1. Remover colunas adicionadas pela migration.
    this.addSql(`
      ALTER TABLE "outbox_messages"
      DROP COLUMN "claim_token",
      DROP COLUMN "lease_until";
    `);

    // 2. Remover constraints atuais.
    this.addSql(`
      ALTER TABLE "wager_transactions"
      DROP CONSTRAINT "wager_status_valid";
    `);

    this.addSql(`
      ALTER TABLE "wager_transactions"
      DROP CONSTRAINT "wager_kind_valid";
    `);

    // 3. Restaurar foreign keys.
    this.addSql(`
      ALTER TABLE "wager_transactions"
      ADD CONSTRAINT "wager_reference_fk"
      FOREIGN KEY ("reference_transaction_id")
      REFERENCES "wager_transactions" ("id")
      ON DELETE RESTRICT;
    `);

    this.addSql(`
      ALTER TABLE "wager_transactions"
      ADD CONSTRAINT "wager_wallet_fk"
      FOREIGN KEY ("wallet_id")
      REFERENCES "wallets" ("id")
      ON DELETE RESTRICT;
    `);

    // 4. Restaurar índice parcial das reversões.
    this.addSql(`
      CREATE UNIQUE INDEX "wager_processed_reversal_unique"
      ON "wager_transactions" (
        "reference_transaction_id",
        "kind"
      )
      WHERE
        status = 'PROCESSED'
        AND kind IN ('REFUND', 'ROLLBACK');
    `);

    // 5. Restaurar constraints de domínio.
    this.addSql(`
      ALTER TABLE "wager_transactions"
      ADD CONSTRAINT "wager_status_valid"
      CHECK (
        status IN (
          'PENDING',
          'PENDING_REFERENCE',
          'PROCESSED',
          'REJECTED',
          'FAILED'
        )
      );
    `);

    this.addSql(`
      ALTER TABLE "wager_transactions"
      ADD CONSTRAINT "wager_kind_valid"
      CHECK (
        kind IN (
          'OPENING',
          'BET',
          'WIN',
          'LOSS',
          'REFUND',
          'ROLLBACK'
        )
      );
    `);

    // 6. Restaurar foreign keys do ledger.
    this.addSql(`
      ALTER TABLE "wallet_ledger_entries"
      ADD CONSTRAINT "ledger_transaction_fk"
      FOREIGN KEY ("transaction_id")
      REFERENCES "wager_transactions" ("id")
      ON DELETE RESTRICT;
    `);

    this.addSql(`
      ALTER TABLE "wallet_ledger_entries"
      ADD CONSTRAINT "ledger_wallet_fk"
      FOREIGN KEY ("wallet_id")
      REFERENCES "wallets" ("id")
      ON DELETE RESTRICT;
    `);

    // 7. Restaurar função que bloqueia alterações.
    this.addSql(`
      CREATE OR REPLACE FUNCTION
        "wallet_ledger_entries_ledger_block_update_delete_fn"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'LEDGER_IMMUTABLE';
      END;
      $$;
    `);

    // 8. Restaurar trigger de UPDATE e DELETE.
    this.addSql(`
      CREATE TRIGGER "ledger_block_update_delete"
      BEFORE UPDATE OR DELETE
      ON "wallet_ledger_entries"
      FOR EACH ROW
      EXECUTE FUNCTION
        "wallet_ledger_entries_ledger_block_update_delete_fn"();
    `);
  }

}
