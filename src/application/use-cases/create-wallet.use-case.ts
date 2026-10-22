
import {
  ConflictException,
  Injectable,
} from '@nestjs/common';

import { randomUUID, createHash } from 'node:crypto';

import { UniqueConstraintViolationException } from
  '@mikro-orm/core';

import {
  Money,
  type MoneyProps,
} from '../../domain/value-objects/money.js';

import { Wallet } from '../../domain/aggregates/wallet.js';

import { WagerTransaction } from
  '../../domain/entities/wager-transaction.js';

import {
  WalletLedgerEntry,
  LedgerDirection,
} from '../../domain/entities/wallet-ledger-entry.js';

import { WalletCreationRepository } from
  '../../infrastructure/persistence/repositories/wallet-creation.repository.js';

import { WalletBalanceChanged } from
  '../../domain/events/wallet-balance-changed.event.js';

import { WagerTransactionProcessed } from
  '../../domain/events/wager-transaction-processed.event.js';

import { OutboxMessage } from
  '../../domain/entities/outbox-message.js';


export interface CreateWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface CreateWalletOutput {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(
    private readonly repository: WalletCreationRepository,
  ) {}

  async execute(
    input: CreateWalletInput,
  ): Promise<CreateWalletOutput> {
    // 1. Validar e criar o valor monetário
    const initialBalance = Money.from(
      input.initialBalance,
    );

    // 2. Criar a carteira no domínio
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: input.playerId,
      initialBalance,
    });

    let opening: WagerTransaction | undefined;
    let ledger: WalletLedgerEntry | undefined;

    const outboxMessages: OutboxMessage[] = [];

    // 3. Saldo positivo exige crédito de abertura
    if (initialBalance.isPositive()) {
      // Hash estável para a operação interna
      const payloadHash = createHash('sha256')
        .update(
          JSON.stringify({
            walletId: wallet.id,
            amount: initialBalance.toJSON().amount,
            currency: wallet.currency,
          }),
        )
        .digest('hex');

      opening = WagerTransaction.createOpening({
        id: randomUUID(),
        walletId: wallet.id,
        playerId: wallet.playerId,
        money: initialBalance,
        payloadHash,
        createdAt: wallet.createdAt,
      });

      opening.markProcessed(
        undefined,
        wallet.createdAt,
      );

      // 4. Criar o lançamento correspondente
      ledger = WalletLedgerEntry.create({
        id: randomUUID(),
        walletId: wallet.id,
        transactionId: opening.id,
        direction: LedgerDirection.Credit,
        money: initialBalance,
        balanceBefore: Money.zero(wallet.currency),
        balanceAfter: wallet.balance,
        createdAt: wallet.createdAt,
      });

      
      // 5: saldo da carteira alterado
      const balanceChanged = WalletBalanceChanged.from(
        wallet,
        ledger,
        {
          eventId: randomUUID(),
          correlationId: opening.id,
          causationId: opening.id,
          occurredAt: wallet.createdAt,
        },
      );

      // 6: transação de abertura processada
      const transactionProcessed =
        WagerTransactionProcessed.from(
          opening,
          wallet,
          {
            eventId: randomUUID(),
            correlationId: opening.id,
            causationId: opening.id,
            occurredAt: wallet.createdAt,
          },
        );

      // Transformar os eventos em mensagens da Outbox
      outboxMessages.push(
        OutboxMessage.enqueue(balanceChanged),
        OutboxMessage.enqueue(transactionProcessed),
      );

    }

    // 5. Persistir atomicamente
    try {
      await this.repository.create(
        wallet,
        opening,
        ledger,
        outboxMessages,
      );
    } catch (error) {
      if (
        error instanceof
        UniqueConstraintViolationException
      ) {
        throw new ConflictException(
          'WALLET_ALREADY_EXISTS',
        );
      }

      throw error;
    }

    // 6. Retornar o resultado
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}
