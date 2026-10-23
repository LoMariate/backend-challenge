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
  wagerLockConflictsTotal,
} from '../../infrastructure/observability/observability.metrics.js';

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
  WalletLedgerEntry
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

import { LedgerDirection } from
  '../../domain/entities/wallet-ledger-entry.js';

import { WagerTransactionPendingReference } from
  '../../domain/events/wager-transaction-pending-reference.event.js';

export interface ProcessWagerInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

// Utilizado futuramente pelo SQS Consumer
export interface InboxContext {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export interface ProcessWagerOutput {
  transactionId: string;
  status: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE';
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
  pending_reference_attempts: number;
  created_at: Date;
}

interface ReferenceRow {
  id: string;
  provider_id: string;
  player_id: string;
  wallet_id: string;
  round_id: string;
  kind: string;
  status: string;
  amount: string;
  currency: string;
}

interface ReferenceRetryState {
  isRetry: boolean;
  attempts: number;
  createdAt: Date;
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
    retryPendingId?: string,
  ): Promise<ProcessWagerOutput> {
    
    const supportedKinds = [
      'BET',
      'WIN',
      'LOSS',
      'REFUND',
      'ROLLBACK',
    ] as const;

    if (!supportedKinds.includes(input.kind)) {
      throw new BadRequestException(
        'UNSUPPORTED_TRANSACTION_KIND',
      );
    }

    // Verificar se a operação exige uma referência.
    const isReversal =
      input.kind === 'REFUND' ||
      input.kind === 'ROLLBACK';

    if (
      isReversal &&
      !input.referenceExternalTransactionId?.trim()
    ) {
      throw new BadRequestException(
        'REFERENCE_EXTERNAL_TRANSACTION_ID_REQUIRED',
      );
    }

    // BET, WIN e LOSS não aceitam referência nesta etapa.
    if (
      !isReversal &&
      input.referenceExternalTransactionId !== undefined
    ) {
      throw new BadRequestException(
        'REFERENCE_NOT_SUPPORTED_FOR_KIND',
      );
    }

    // MANTER: validação dos identificadores.
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
      referenceExternalTransactionId: input.referenceExternalTransactionId ?? null,
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
        id: retryPendingId ?? randomUUID(),
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
          REFUND: WagerTransactionKind.Refund,
          ROLLBACK: WagerTransactionKind.Rollback,
        }[input.kind],
        referenceExternalTransactionId: input.referenceExternalTransactionId,
        money,
      });

      // 4. Reservar a identidade da transação
      // usando UNIQUE do PostgreSQL. 
      const reserved = retryPendingId
        ? []
        : await tx.execute<{ id: string }[]>(
            `
            INSERT INTO wager_transactions (
              id, provider_id, external_transaction_id,
              idempotency_key, payload_hash,
              wallet_id, player_id, round_id, game_id,
              kind, amount, currency,
              reference_external_transaction_id,
              status, created_at
            )
            VALUES (
              ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, 'PENDING', ?
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
              wager.referenceExternalTransactionId ?? null,
              wager.createdAt,
            ],
          );

      // 5. Se já existe, verificar replay ou conflito.
      let retryAttempts = 0;
      let pendingSince = wager.createdAt;

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
          previous.status === 'PENDING_REFERENCE' &&
          retryPendingId === previous.id
        ) {
          // Reprocessamento interno autorizado.
          // Não geramos um novo ID nem uma nova transação.
          wager.markPendingReference();

          retryAttempts = previous.pending_reference_attempts;
          pendingSince = new Date(previous.created_at);
        } else {
          if (
            previous.status !== 'PROCESSED' &&
            previous.status !== 'REJECTED' &&
            previous.status !== 'PENDING_REFERENCE'
          ) {
            throw new ServiceUnavailableException(
              'TRANSACTION_STILL_PENDING',
            );
          }

          if (previous.observed_balance === null) {
            throw new ServiceUnavailableException(
              'TRANSACTION_BALANCE_NOT_RECORDED',
            );
          }

          await this.markInboxProcessed(tx, inbox);

          return {
            transactionId: previous.id,
            status: previous.status as ProcessWagerOutput['status'],
            balance: {
              amount: previous.observed_balance,
              currency: money.currency,
            },
            failureCode: previous.failure_code ?? undefined,
            idempotentReplay: true,
          };
        }

      }

      // Inbox já confirmada nunca deve apontar
      // para uma operação financeira inexistente.
      if (existingInboxProcessed) {
        throw new ServiceUnavailableException(
          'INBOX_TRANSACTION_MISSING',
        );
      }

      if (isReversal) {
        return this.processReversal(
          tx,
          wager,
          wallet,
          money,
          input,
          inbox,
          {
            isRetry: retryPendingId !== undefined,
            attempts: retryAttempts,
            createdAt: pendingSince,
          },
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
          wagerLockConflictsTotal.inc({
            reason: 'version_mismatch',
          });

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
  
private async processReversal(
  tx: EntityManager,
  wager: WagerTransaction,
  wallet: Wallet,
  money: Money,
  input: ProcessWagerInput,
  inbox: InboxContext | undefined,
  retry: ReferenceRetryState,
): Promise<ProcessWagerOutput> {
  // 1. Validar identidade e moeda da wallet.
  if (
    wallet.playerId !== input.playerId ||
    wallet.currency !== money.currency
  ) {
    return this.rejectReversal(
      tx,
      wager,
      wallet,
      FailureCode.InvalidTransaction,
      inbox,
    );
  }

  // 2. Buscar a transação original no mesmo provedor.
  const references = await tx.execute<ReferenceRow[]>(
    `
    SELECT
      id,
      provider_id,
      player_id,
      wallet_id,
      round_id,
      kind,
      status,
      amount,
      currency
    FROM wager_transactions
    WHERE provider_id = ?
      AND external_transaction_id = ?
    LIMIT 1
    `,
    [
      input.providerId,
      input.referenceExternalTransactionId,
    ],
  );

  const reference = references[0];

  // 3. Referência ausente ou ainda pendente.
  if (
    !reference ||
    reference.status === 'PENDING' ||
    reference.status === 'PENDING_REFERENCE'
  ) {
    return this.awaitReference(
      tx,
      wager,
      wallet,
      inbox,
      retry,
    );
  }

  // 4. Só é possível reverter uma referência processada.
  if (reference.status !== 'PROCESSED') {
    return this.rejectReversal(
      tx,
      wager,
      wallet,
      FailureCode.InvalidTransaction,
      inbox,
    );
  }

  // 5. Conferir vínculo entre referência e reversão.
  if (
    reference.id === wager.id ||
    reference.provider_id !== input.providerId ||
    reference.player_id !== input.playerId ||
    reference.wallet_id !== input.walletId ||
    reference.round_id !== input.roundId ||
    reference.currency !== money.currency
  ) {
    return this.rejectReversal(
      tx,
      wager,
      wallet,
      FailureCode.InvalidTransaction,
      inbox,
    );
  }

  // 6. Validar os tipos de referência permitidos.
  const validReferenceKind =
    input.kind === 'REFUND'
      ? reference.kind === 'BET'
      : ['BET', 'WIN', 'REFUND'].includes(reference.kind);

  if (!validReferenceKind) {
    return this.rejectReversal(
      tx,
      wager,
      wallet,
      FailureCode.InvalidTransaction,
      inbox,
    );
  }

  // 7. Reversão deve ter o valor original exato.
  const originalMoney = Money.from({
    amount: reference.amount,
    currency: reference.currency,
  });

  if (!money.equals(originalMoney)) {
    return this.rejectReversal(
      tx,
      wager,
      wallet,
      FailureCode.InvalidTransaction,
      inbox,
    );
  }

  // 8. Verificar se a referência já foi revertida.
  // Para BET, impedimos também REFUND + ROLLBACK,
  // pois ambos devolveriam o mesmo débito.
  const previousReversals = await tx.execute<
    { id: string }[]
  >(
    `
    SELECT id
    FROM wager_transactions
    WHERE reference_transaction_id = ?
      AND status = 'PROCESSED'
      AND (
        kind = ?
        OR (
          ? = 'BET'
          AND kind IN ('REFUND', 'ROLLBACK')
        )
      )
    LIMIT 1
    `,
    [
      reference.id,
      input.kind,
      reference.kind,
    ],
  );

  if (previousReversals.length > 0) {
    return this.rejectReversal(
      tx,
      wager,
      wallet,
      FailureCode.ReferenceAlreadyReversed,
      inbox,
    );
  }

  // 9. Determinar o movimento inverso.
  // BET é débito, portanto a reversão credita.
  // WIN e REFUND são créditos, portanto
  // o ROLLBACK dessas operações debita.
  const direction =
    reference.kind === 'BET'
      ? LedgerDirection.Credit
      : LedgerDirection.Debit;

  // 10. Proteger reversões que retiram dinheiro.
  if (
    direction === LedgerDirection.Debit &&
    wallet.balance.isLessThan(money)
  ) {
    return this.rejectReversal(
      tx,
      wager,
      wallet,
      FailureCode.ReversalInsufficientFunds,
      inbox,
    );
  }

  // 11. Aplicar movimento usando o domínio Wallet.
  const originalVersion = wallet.version;

  const movement =
    direction === LedgerDirection.Credit
      ? wallet.credit(money)
      : wallet.debit(money);

  // 12. Atualizar saldo com versionamento.
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
      wagerLockConflictsTotal.inc({
        reason: 'version_mismatch',
      });

      throw new ServiceUnavailableException(
        'WALLET_CONCURRENT_UPDATE',
      );
    }


  // 13. Gerar lançamento imutável no ledger.
  const ledger = WalletLedgerEntry.create({
    id: randomUUID(),
    walletId: wallet.id,
    transactionId: wager.id,
    direction,
    money,
    balanceBefore: movement.balanceBefore,
    balanceAfter: movement.balanceAfter,
  });

  await tx.execute(
    `
    INSERT INTO wallet_ledger_entries (
      id,
      wallet_id,
      transaction_id,
      direction,
      amount,
      currency,
      balance_before,
      balance_after,
      created_at
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

  // 14. Marcar reversão como processada.
  wager.markProcessed(reference.id, new Date());

  await tx.execute(
    `
    UPDATE wager_transactions
    SET status = 'PROCESSED',
        reference_transaction_id = ?,
        observed_balance = ?,
        processed_at = ?,
        next_reference_attempt_at = NULL
    WHERE id = ?
    `,
    [
      reference.id,
      wallet.balance.toJSON().amount,
      wager.processedAt,
      wager.id,
    ],
  );

  // 15. Persistir os eventos na Outbox.
  const ctx = {
    correlationId: wager.id,
    causationId: wager.id,
    occurredAt: new Date(),
  };

  const processed = WagerTransactionProcessed.from(
    wager,
    wallet,
    {
      ...ctx,
      eventId: randomUUID(),
    },
  );

  const balanceChanged = WalletBalanceChanged.from(
    wallet,
    ledger,
    {
      ...ctx,
      eventId: randomUUID(),
    },
  );

  await this.saveOutbox(tx, [
    OutboxMessage.enqueue(processed),
    OutboxMessage.enqueue(balanceChanged),
  ]);

  // 16. Confirmar Inbox na mesma transação.
  await this.markInboxProcessed(tx, inbox);

  return {
    transactionId: wager.id,
    status: 'PROCESSED',
    balance: wallet.balance.toJSON(),
    idempotentReplay: false,
  };
}
    
  private async rejectReversal(
    tx: EntityManager,
    wager: WagerTransaction,
    wallet: Wallet,
    code: FailureCode,
    inbox?: InboxContext,
  ): Promise<ProcessWagerOutput> {
    wager.reject(code);

    await tx.execute(
      `
      UPDATE wager_transactions
      SET status = 'REJECTED',
          failure_code = ?,
          observed_balance = ?,
          next_reference_attempt_at = NULL
      WHERE id = ?
      `,
      [
        code,
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
      failureCode: code,
      idempotentReplay: false,
    };
  }

  private async awaitReference(
    tx: EntityManager,
    wager: WagerTransaction,
    wallet: Wallet,
    inbox: InboxContext | undefined,
    retry: ReferenceRetryState,
  ): Promise<ProcessWagerOutput> {
    const expired =
      retry.attempts >= 8 ||
      Date.now() - retry.createdAt.getTime() >=
        24 * 60 * 60 * 1000;

    if (retry.isRetry && expired) {
      return this.rejectReversal(
        tx,
        wager,
        wallet,
        FailureCode.ReferenceNotFound,
        inbox,
      );
    }

    if (
      wager.status !==
      WagerTransactionStatus.PendingReference
    ) {
      wager.markPendingReference();
    }

    const increment = retry.isRetry ? 1 : 0;

    await tx.execute(
      `
      UPDATE wager_transactions
      SET status = 'PENDING_REFERENCE',
          observed_balance = ?,
          pending_reference_attempts =
            pending_reference_attempts + ?,
          next_reference_attempt_at =
            NOW() + make_interval(
              secs => LEAST(
                300,
                1 << LEAST(
                  pending_reference_attempts + ?, 8
                )
              )
            )
      WHERE id = ?
        AND status IN ('PENDING', 'PENDING_REFERENCE')
      `,
      [
        wallet.balance.toJSON().amount,
        increment,
        increment,
        wager.id,
      ],
    );

    // Apenas a primeira entrada em PENDING_REFERENCE
    // produz o evento. Reavaliações não duplicam eventos.
    if (!retry.isRetry) {
      const event =
        WagerTransactionPendingReference.from(
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
    }

    // A Inbox pode ser confirmada: a solicitação já
    // foi persistida e o worker assumirá a pendência.
    await this.markInboxProcessed(tx, inbox);

    return {
      transactionId: wager.id,
      status: 'PENDING_REFERENCE',
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
    };
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

  async retryPendingReference(
    transactionId: string,
  ): Promise<void> {
    const rows = await this.em.fork().execute<{
      provider_id: string;
      external_transaction_id: string;
      idempotency_key: string;
      player_id: string;
      wallet_id: string;
      round_id: string;
      game_id: string;
      kind: 'REFUND' | 'ROLLBACK';
      amount: string;
      currency: string;
      reference_external_transaction_id: string;
    }[]>(
      `
      SELECT
        provider_id,
        external_transaction_id,
        idempotency_key,
        player_id,
        wallet_id,
        round_id,
        game_id,
        kind,
        amount,
        currency,
        reference_external_transaction_id
      FROM wager_transactions
      WHERE id = ?
        AND status = 'PENDING_REFERENCE'
        AND kind IN ('REFUND', 'ROLLBACK')
      `,
      [transactionId],
    );

    const row = rows[0];

    if (!row) {
      return;
    }

    await this.execute(
      {
        providerId: row.provider_id,
        externalTransactionId:
          row.external_transaction_id,
        idempotencyKey: row.idempotency_key,
        playerId: row.player_id,
        walletId: row.wallet_id,
        roundId: row.round_id,
        gameId: row.game_id,
        kind: row.kind,
        money: {
          amount: row.amount,
          currency: row.currency,
        },
        referenceExternalTransactionId:
          row.reference_external_transaction_id,
      },
      undefined,
      transactionId,
    );
  }
}