import { Migration } from '@mikro-orm/migrations';

/**
 * Completa as garantias financeiras ausentes no schema reconstruido.
 *
 * Pre-requisito: uma migration anterior cria a funcao
 * public.prevent_ledger_mutation() e o trigger ledger_block_truncate.
 *
 * Esta migration nao recria nem remove esses objetos preexistentes.
 */
export class Migration20261024000000 extends Migration {
  async up(): Promise<void> {
    // Uma reversao PROCESSADA por referencia + tipo (auditoria do desafio).
    this.addSql(`
      CREATE UNIQUE INDEX "uq_wager_processed_reversal_kind_20261024"
      ON "public"."wager_transactions"
        ("reference_transaction_id", "kind")
      WHERE "status" = 'PROCESSED'
        AND "kind" IN ('REFUND', 'ROLLBACK');
    `);

    // Defesa adicional: nao permitir REFUND e ROLLBACK processados
    // simultaneamente contra a mesma transacao original.
    this.addSql(`
      CREATE UNIQUE INDEX "uq_wager_processed_reversal_reference_20261024"
      ON "public"."wager_transactions"
        ("reference_transaction_id")
      WHERE "status" = 'PROCESSED'
        AND "kind" IN ('REFUND', 'ROLLBACK');
    `);

    // Uma reversao PROCESSADA obrigatoriamente tem referencia interna
    // resolvida. Sem isto, UNIQUE permitiria multiplos valores NULL.
    this.addSql(`
      ALTER TABLE "public"."wager_transactions"
      ADD CONSTRAINT "ck_processed_reversal_has_ref_20261024"
      CHECK (
        "status" <> 'PROCESSED'
        OR "kind" NOT IN ('REFUND', 'ROLLBACK')
        OR "reference_transaction_id" IS NOT NULL
      );
    `);

    // Integridade referencial do ledger: a wallet e a transacao
    // precisam existir. RESTRICT impede exclusao do registro pai.
    this.addSql(`
      ALTER TABLE "public"."wallet_ledger_entries"
      ADD CONSTRAINT "fk_ledger_wallet_20261024"
      FOREIGN KEY ("wallet_id")
      REFERENCES "public"."wallets" ("id")
      ON UPDATE RESTRICT ON DELETE RESTRICT;
    `);

    this.addSql(`
      ALTER TABLE "public"."wallet_ledger_entries"
      ADD CONSTRAINT "fk_ledger_transaction_20261024"
      FOREIGN KEY ("transaction_id")
      REFERENCES "public"."wager_transactions" ("id")
      ON UPDATE RESTRICT ON DELETE RESTRICT;
    `);

    // A referencia interna e opcional em transacoes que nao revertem
    // outra transacao; quando preenchida, precisa existir.
    this.addSql(`
      ALTER TABLE "public"."wager_transactions"
      ADD CONSTRAINT "fk_wager_reversal_ref_20261024"
      FOREIGN KEY ("reference_transaction_id")
      REFERENCES "public"."wager_transactions" ("id")
      ON UPDATE RESTRICT ON DELETE RESTRICT;
    `);

    // Reutilizar a funcao de bloqueio JA existente, usada pelo
    // trigger de TRUNCATE; nenhum UPDATE ou DELETE e permitido.
    this.addSql(`
      CREATE TRIGGER "ledger_block_update_20261024"
      BEFORE UPDATE ON "public"."wallet_ledger_entries"
      FOR EACH STATEMENT
      EXECUTE FUNCTION "public"."prevent_ledger_mutation"();
    `);

    this.addSql(`
      CREATE TRIGGER "ledger_block_delete_20261024"
      BEFORE DELETE ON "public"."wallet_ledger_entries"
      FOR EACH STATEMENT
      EXECUTE FUNCTION "public"."prevent_ledger_mutation"();
    `);
  }

  async down(): Promise<void> {
    // Reverter SOMENTE os objetos introduzidos nesta migration.
    this.addSql(`
      DROP TRIGGER IF EXISTS "ledger_block_delete_20261024"
      ON "public"."wallet_ledger_entries";
    `);

    this.addSql(`
      DROP TRIGGER IF EXISTS "ledger_block_update_20261024"
      ON "public"."wallet_ledger_entries";
    `);

    this.addSql(`
      ALTER TABLE "public"."wager_transactions"
      DROP CONSTRAINT IF EXISTS "fk_wager_reversal_ref_20261024";
    `);

    this.addSql(`
      ALTER TABLE "public"."wallet_ledger_entries"
      DROP CONSTRAINT IF EXISTS "fk_ledger_transaction_20261024";
    `);

    this.addSql(`
      ALTER TABLE "public"."wallet_ledger_entries"
      DROP CONSTRAINT IF EXISTS "fk_ledger_wallet_20261024";
    `);

    this.addSql(`
      ALTER TABLE "public"."wager_transactions"
      DROP CONSTRAINT IF EXISTS "ck_processed_reversal_has_ref_20261024";
    `);

    this.addSql(`
      DROP INDEX IF EXISTS "public"."uq_wager_processed_reversal_reference_20261024";
    `);

    this.addSql(`
      DROP INDEX IF EXISTS "public"."uq_wager_processed_reversal_kind_20261024";
    `);
  }
}
