import { Injectable } from '@nestjs/common';

import {
  ProcessWagerTransactionUseCase,
} from '../../application/use-cases/process-wager-transaction.use-case.js';

import {
  type WagerMessageHandler,
  type WagerTransactionRequested,
} from '../../application/ports/wager-message-handler.js';

import {
  payloadHash,
} from '../../application/services/payload-hash.js';

@Injectable()
export class SqsWagerMessageHandler
  implements WagerMessageHandler {

  constructor(
    private readonly processWager:
      ProcessWagerTransactionUseCase,
  ) {}

  async handle(
    message: WagerTransactionRequested,
  ): Promise<void> {
    const data = message.data;

    // Hash canônico do conteúdo de negócio.
    // Não depende de ordem das chaves JSON.
    const inboxHash = payloadHash({
      type: message.type,
      data,
    });

    // Reutiliza o MESMO caso de uso do HTTP.
    // A Inbox será confirmada dentro da
    // mesma transação SQL da operação financeira.
    await this.processWager.execute(
      {
        providerId: data.providerId,
        externalTransactionId:
          data.externalTransactionId,
        idempotencyKey: data.idempotencyKey,
        playerId: data.playerId,
        walletId: data.walletId,
        roundId: data.roundId,
        gameId: data.gameId,
        kind: data.kind,
        money: data.money,
        referenceExternalTransactionId:
          data.referenceExternalTransactionId,
      },
      {
        consumerName: 'wager-transactions-consumer',
        messageId: message.messageId,
        payloadHash: inboxHash,
      },
    );
  }
}
