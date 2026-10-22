import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { randomUUID } from 'node:crypto';
import { EntityManager } from '@mikro-orm/postgresql';

import {
  Money,
  type MoneyProps,
} from '../../domain/value-objects/money.js';

import { Wallet } from
  '../../domain/aggregates/wallet.js';

import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  FailureCode,
} from '../../domain/entities/wager-transaction.js';

import {
  WalletLedgerEntry,
  LedgerDirection,
} from '../../domain/entities/wallet-ledger-entry.js';

import { OutboxMessage } from
  '../../domain/entities/outbox-message.js';

import { WalletBalanceChanged } from
  '../../domain/events/wallet-balance-changed.event.js';

import { WagerTransactionProcessed } from
  '../../domain/events/wager-transaction-processed.event.js';

import { WagerTransactionRejected } from
  '../../domain/events/wager-transaction-rejected.event.js';

import { payloadHash } from
  '../services/payload-hash.js';

export interface ProcessWagerInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: 'BET' | 'WIN' | 'LOSS';
  money: MoneyProps;
}

// Utilizado futuramente pelo SQS Consumer
export interface InboxContext {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export interface ProcessWagerOutput {
  transactionId: string;
  status: 'PROCESSED' | 'REJECTED';
  balance: MoneyProps;
  failureCode?: string;
  idempotentReplay: boolean;
}

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface TransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  status: string;
  observed_balance: string | null;
  failure_code: string | null;
}

interface InboxRow {
  payload_hash: string;
  processed_at: Date | null;
}

@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly em: EntityManager,
  ) {}

  async execute(
    input: ProcessWagerInput,
    inbox?: InboxContext,
  ): Promise<ProcessWagerOutput> {
    
    if (
      input.kind !== 'BET' &&
      input.kind !== 'WIN' &&
      input.kind !== 'LOSS'
    ) {
      throw new BadRequestException(
        'UNSUPPORTED_TRANSACTION_KIND',
      );
    }


    if (
      !input.idempotencyKey?.trim() ||
      !input.providerId?.trim() ||
      !input.externalTransactionId?.trim()
    ) {
      throw new BadRequestException(
        'INVALID_TRANSACTION_IDENTIFIERS',
      );
    }

    if (input.providerId === 'internal') {
      throw new BadRequestException(
        'INTERNAL_PROVIDER_RESERVED',
      );
    }

    const money = Money.from(input.money);

    if (!money.isPositive()) {
      throw new BadRequestException(
        'INVALID_BET_AMOUNT',
      );
    }

    const hash = payloadHash({
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: money.toJSON(),
      referenceExternalTransactionId: null,
    });

    // clear:true evita compartilhar o Identity Map
    // entre transações concorrentes.
    return this.em.transactional(async (tx) => {
      // 1. Bloqueia somente esta wallet.
      const walletRows = await tx.execute<WalletRow[]>(
        `
        SELECT id, player_id, currency, balance,
               version, created_at, updated_at
        FROM wallets
        WHERE id = ?
        FOR UPDATE
        `,
        [input.walletId],
      );

      const row = walletRows[0];

      if (!row) {
        throw new NotFoundException('WALLET_NOT_FOUND');
      }

      const wallet = Wallet.rehydrate({
        id: row.id,
        playerId: row.player_id,
        currency: row.currency,
        balance: Money.from({
          amount: row.balance,
          currency: row.currency,
        }),
        version: row.version,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      });

      // 2. Registra/verifica Inbox se veio do SQS.
      let existingInboxProcessed = false;

      if (inbox) {
        if (!/^[a-f0-9]{64}$/.test(inbox.payloadHash)) {
          throw new BadRequestException(
            'INVALID_INBOX_HASH',
          );
        }

        const inserted = await tx.execute<{ id: string }[]>(
          `
          INSERT INTO inbox_messages (
            id, consumer_name, message_id,
            payload_hash, received_at
          )
          VALUES (?, ?, ?, ?, NOW())
          ON CONFLICT (consumer_name, message_id)
          DO NOTHING
          RETURNING id
          `,
          [
            randomUUID(),
            inbox.consumerName,
            inbox.messageId,
            inbox.payloadHash,
          ],
        );

        if (inserted.length === 0) {
          const previous = await tx.execute<InboxRow[]>(
            `
            SELECT payload_hash, processed_at
            FROM inbox_messages
            WHERE consumer_name = ?
              AND message_id = ?
            FOR UPDATE
            `,
            [inbox.consumerName, inbox.messageId],
          );

          const existing = previous[0];

          if (!existing) {
            throw new ServiceUnavailableException(
              'INBOX_STATE_UNAVAILABLE',
            );
          }

          if (
            existing.payload_hash !== inbox.payloadHash
          ) {
            throw new ConflictException(
              'INBOX_PAYLOAD_CONFLICT',
            );
          }

          if (!existing.processed_at) {
            throw new ServiceUnavailableException(
              'INBOX_PROCESSING_INCOMPLETE',
            );
          }

          existingInboxProcessed = true;
        }
      }

      // 3. Criar o objeto de domínio.
      const wager = WagerTransaction.create({
        id: randomUUID(),
        providerId: input.providerId,
        externalTransactionId:
          input.externalTransactionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash: hash,
        walletId: input.walletId,
        playerId: input.playerId,
        roundId: input.roundId,
        gameId: input.gameId,        
        kind: {
          BET: WagerTransactionKind.Bet,
          WIN: WagerTransactionKind.Win,
          LOSS: WagerTransactionKind.Loss,
        }[input.kind],
        money,
      });

      // 4. Reservar a identidade da transação
      // usando UNIQUE do PostgreSQL.
      const reserved = await tx.execute<{ id: string }[]>(
        `
        INSERT INTO wager_transactions (
          id, provider_id, external_transaction_id,
          idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id,
          kind, amount, currency, status, created_at
        )
        VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, 'PENDING', ?
        )
        ON CONFLICT DO NOTHING
        RETURNING id
        `,
        [
          wager.id,
          wager.providerId,
          wager.externalTransactionId,
          wager.idempotencyKey,
          wager.payloadHash,
          wager.walletId,
          wager.playerId,
          wager.roundId,
          wager.gameId,
          wager.kind,
          money.toJSON().amount,
          money.currency,
          wager.createdAt,
        ],
      );

      // 5. Se já existe, verificar replay ou conflito.
      if (reserved.length === 0) {
        const rows = await tx.execute<TransactionRow[]>(
          `
          SELECT id, provider_id,
                 external_transaction_id,
                 idempotency_key, payload_hash,
                 status, observed_balance, failure_code
          FROM wager_transactions
          WHERE provider_id = ?
            AND (
              idempotency_key = ?
              OR external_transaction_id = ?
            )
          FOR UPDATE
          `,
          [
            input.providerId,
            input.idempotencyKey,
            input.externalTransactionId,
          ],
        );

        if (
          rows.length !== 1 ||
          rows[0].idempotency_key !==
            input.idempotencyKey ||
          rows[0].external_transaction_id !==
            input.externalTransactionId ||
          rows[0].payload_hash !== hash
        ) {
          throw new ConflictException(
            'IDEMPOTENCY_CONFLICT',
          );
        }

        const previous = rows[0];

        if (
          (previous.status !== 'PROCESSED' &&
            previous.status !== 'REJECTED') ||
          previous.observed_balance === null
        ) {
          throw new ServiceUnavailableException(
            'TRANSACTION_STILL_PENDING',
          );
        }

        await this.markInboxProcessed(tx, inbox);

        return {
          transactionId: previous.id,
          status: previous.status,
          balance: {
            amount: previous.observed_balance,
            currency: money.currency,
          },
          failureCode:
            previous.failure_code ?? undefined,
          idempotentReplay: true,
        };
      }

      // Inbox já confirmada nunca deve apontar
      // para uma operação financeira inexistente.
      if (existingInboxProcessed) {
        throw new ServiceUnavailableException(
          'INBOX_TRANSACTION_MISSING',
        );
      }

      // 6. Validar vínculo entre operação e wallet.
      let rejection: FailureCode | undefined;
     
      if (
        wallet.playerId !== input.playerId ||
        wallet.currency !== money.currency
      ) {
        rejection = FailureCode.InvalidTransaction;
      } else if (
        input.kind === 'BET' &&
        wallet.balance.isLessThan(money)
      ) {
        rejection = FailureCode.InsufficientFunds;
      }

      if (rejection) {
        wager.reject(rejection);

        await tx.execute(
          `
          UPDATE wager_transactions
          SET status = 'REJECTED',
              failure_code = ?,
              observed_balance = ?
          WHERE id = ?
          `,
          [
            rejection,
            wallet.balance.toJSON().amount,
            wager.id,
          ],
        );

        const event = WagerTransactionRejected.from(
          wager,
          wallet,
          {
            eventId: randomUUID(),
            correlationId: wager.id,
            causationId: wager.id,
            occurredAt: new Date(),
          },
        );

        await this.saveOutbox(
          tx,
          [OutboxMessage.enqueue(event)],
        );

        await this.markInboxProcessed(tx, inbox);

        return {
          transactionId: wager.id,
          status: 'REJECTED',
          balance: wallet.balance.toJSON(),
          failureCode: rejection,
          idempotentReplay: false,
        };
      }

      
      // 7. Movimentar o saldo somente quando necessário.
      let ledger: WalletLedgerEntry | undefined;

      if (wager.affectsBalance()) {
        const originalVersion = wallet.version;

        // BET debita; WIN credita.
        const movement =
          wager.kind === WagerTransactionKind.Bet
            ? wallet.debit(money)
            : wallet.credit(money);

        // 8. Salvar saldo com controle de concorrência.
        const updated = await tx.execute<{ id: string }[]>(
          `
          UPDATE wallets
          SET balance = ?,
              version = ?,
              updated_at = ?
          WHERE id = ?
            AND version = ?
          RETURNING id
          `,
          [
            wallet.balance.toJSON().amount,
            wallet.version,
            wallet.updatedAt,
            wallet.id,
            originalVersion,
          ],
        );

        if (updated.length !== 1) {
          throw new ServiceUnavailableException(
            'WALLET_CONCURRENT_UPDATE',
          );
        }

        // 9. Criar o lançamento financeiro.
        ledger = WalletLedgerEntry.create({
          id: randomUUID(),
          walletId: wallet.id,
          transactionId: wager.id,
          direction: wager.ledgerDirectionFor(),
          money,
          balanceBefore: movement.balanceBefore,
          balanceAfter: movement.balanceAfter,
        });

        await tx.execute(
          `
          INSERT INTO wallet_ledger_entries (
            id, wallet_id, transaction_id, direction,
            amount, currency, balance_before,
            balance_after, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            ledger.id,
            ledger.walletId,
            ledger.transactionId,
            ledger.direction,
            ledger.money.toJSON().amount,
            ledger.money.currency,
            ledger.balanceBefore.toJSON().amount,
            ledger.balanceAfter.toJSON().amount,
            ledger.createdAt,
          ],
        );
      }

      // LOSS não entra no bloco acima.
      // Portanto:
      // - Não altera o saldo.
      // - Não incrementa a versão.
      // - Não cria entrada no ledger.


      // 10. Marcar a aposta como processada.
      wager.markProcessed(undefined, new Date());

      await tx.execute(
        `
        UPDATE wager_transactions
        SET status = 'PROCESSED',
            processed_at = ?,
            observed_balance = ?
        WHERE id = ?
        `,
        [
          wager.processedAt,
          wallet.balance.toJSON().amount,
          wager.id,
        ],
      );

      // 11. Gerar eventos de integração.
      const ctx = {
        correlationId: wager.id,
        causationId: wager.id,
        occurredAt: new Date(),
      };

      // Toda operação processada gera esse evento,
      // inclusive LOSS.
      const processed = WagerTransactionProcessed.from(
        wager,
        wallet,
        {
          ...ctx,
          eventId: randomUUID(),
        },
      );

      const outboxMessages: OutboxMessage[] = [
        OutboxMessage.enqueue(processed),
      ];

      // Somente operações com ledger alteraram saldo.
      if (ledger) {
        const balanceChanged = WalletBalanceChanged.from(
          wallet,
          ledger,
          {
            ...ctx,
            eventId: randomUUID(),
          },
        );

        outboxMessages.push(
          OutboxMessage.enqueue(balanceChanged),
        );
      }

      await this.saveOutbox(tx, outboxMessages);

      // 12. Concluir Inbox, se a origem for SQS.
      await this.markInboxProcessed(tx, inbox);

      return {
        transactionId: wager.id,
        status: 'PROCESSED',
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
      };
    }, { clear: true });
  }

  // Persiste os eventos sem publicá-los no SQS.
  private async saveOutbox(
    tx: EntityManager,
    messages: readonly OutboxMessage[],
  ): Promise<void> {
    for (const message of messages) {
      await tx.execute(
        `
        INSERT INTO outbox_messages (
          id, aggregate_id, event_type,
          payload, occurred_at, attempts
        )
        VALUES (?, ?, ?, CAST(? AS jsonb), ?, 0)
        `,
        [
          message.id,
          message.aggregateId,
          message.eventType,
          JSON.stringify(message.payload),
          message.occurredAt,
        ],
      );
    }
  }

  // Inbox e operação financeira participam
  // da mesma transação SQL.
  private async markInboxProcessed(
    tx: EntityManager,
    inbox?: InboxContext,
  ): Promise<void> {
    if (!inbox) {
      return;
    }

    await tx.execute(
      `
      UPDATE inbox_messages
      SET processed_at = NOW()
      WHERE consumer_name = ?
        AND message_id = ?
        AND processed_at IS NULL
      `,
      [inbox.consumerName, inbox.messageId],
    );
  }
}