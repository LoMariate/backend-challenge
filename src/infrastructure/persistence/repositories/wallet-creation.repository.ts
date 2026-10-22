import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

import { Wallet } from '../../../domain/aggregates/wallet.js';

import { WagerTransaction } from '../../../domain/entities/wager-transaction.js';

import { WalletLedgerEntry } from '../../../domain/entities/wallet-ledger-entry.js';

import { WalletOrmEntity } from '../entities/wallet.orm-entity.js';

import { WagerTransactionOrmEntity } from '../entities/wager-transaction.orm-entity.js';

import { WalletLedgerEntryOrmEntity } from '../entities/wallet-ledger-entry.orm-entity.js';

import { OutboxMessage } from '../../../domain/entities/outbox-message.js';

import { OutboxMessageOrmEntity } from '../entities/outbox-message.orm-entity.js';

@Injectable()
export class WalletCreationRepository {
  constructor(
    private readonly em: EntityManager,
  ) {}

  async create(
    wallet: Wallet,
    opening?: WagerTransaction,
    ledger?: WalletLedgerEntry,
    outbox: readonly OutboxMessage[] = [],
  ): Promise<void> {
    if (Boolean(opening) !== Boolean(ledger)) {
      throw new Error('OPENING_LEDGER_REQUIRED');
    }
    
  if (Boolean(opening) !== Boolean(ledger)) {
    throw new Error('OPENING_LEDGER_REQUIRED');
  }

  if (
    wallet.balance.isPositive() &&
    (!opening || !ledger || outbox.length === 0)
  ) {
    throw new Error('OPENING_AND_OUTBOX_REQUIRED');
  }

  if (
    opening &&
    ledger &&
    (
      opening.walletId !== wallet.id ||
      ledger.walletId !== wallet.id ||
      ledger.transactionId !== opening.id ||
      !ledger.isBalanced()
    )
  ) {
    throw new Error('INVALID_OPENING_LEDGER');
  }

    await this.em.transactional(async (tx) => {
      // 1. Salvar a carteira
      const walletEntity = tx.create(WalletOrmEntity, {
        id: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balance: wallet.balance.toJSON().amount,
        version: wallet.version,
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
      });

      await tx.flush();;

      // Wallet com saldo zero não gera OPENING.
      if (!opening || !ledger) {
        return;
      }

      // 2. Salvar a transação OPENING
      const transactionEntity = tx.create(
        WagerTransactionOrmEntity,
        {
          id: opening.id,
          providerId: opening.providerId,
          externalTransactionId:
            opening.externalTransactionId,
          idempotencyKey: opening.idempotencyKey,
          payloadHash: opening.payloadHash,
          walletId: opening.walletId,
          playerId: opening.playerId,
          roundId: opening.roundId,
          gameId: opening.gameId,
          kind: opening.kind,
          amount: opening.money.toJSON().amount,
          currency: opening.money.currency,
          status: opening.status,
          observedBalance: wallet.balance.toJSON().amount,
          createdAt: opening.createdAt,
          processedAt: opening.processedAt,
        },
      );

      await tx.flush();

      // 3. Salvar o lançamento financeiro
      const ledgerEntity = tx.create(
        WalletLedgerEntryOrmEntity,
        {
          id: ledger.id,
          walletId: ledger.walletId,
          transactionId: ledger.transactionId,
          direction: ledger.direction,
          amount: ledger.money.toJSON().amount,
          currency: ledger.money.currency,
          balanceBefore:
            ledger.balanceBefore.toJSON().amount,
          balanceAfter:
            ledger.balanceAfter.toJSON().amount,
          createdAt: ledger.createdAt,
        },
      );

      await tx.flush();
      
      // Persistir os eventos financeiros na mesma
      // transação SQL da wallet, OPENING e ledger.
      for (const message of outbox) {
        tx.create(OutboxMessageOrmEntity, {
          id: message.id,
          aggregateId: message.aggregateId,
          eventType: message.eventType,
          payload: { ...message.payload },
          occurredAt: message.occurredAt,
          attempts: message.attempts,
          nextAttemptAt: message.nextAttemptAt,
          publishedAt: message.publishedAt,
        });
      }

      // Ainda não é COMMIT: apenas envia as inserções
      // pendentes ao PostgreSQL.
      await tx.flush();

    });
  }
}
