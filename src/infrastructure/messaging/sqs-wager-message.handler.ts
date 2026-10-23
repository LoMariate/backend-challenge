import {
  Injectable,
  Logger,
} from '@nestjs/common';

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

import {
  wagerOperationsTotal,
  wagerDuplicatesTotal,
  wagerProcessingDuration,
} from '../observability/observability.metrics.js';

@Injectable()
export class SqsWagerMessageHandler
  implements WagerMessageHandler {

  private readonly logger = new Logger(
    SqsWagerMessageHandler.name,
  );

  constructor(
    private readonly processWager:
      ProcessWagerTransactionUseCase,
  ) {}

  async handle(
    message: WagerTransactionRequested,
  ): Promise<void> {
    const data = message.data;

    const inboxHash = payloadHash({
      type: message.type,
      data,
    });

    const stopTimer = wagerProcessingDuration.startTimer({
      kind: data.kind,
      source: 'sqs',
    });

    try {
      const result = await this.processWager.execute(
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

      if (result.idempotentReplay) {
        wagerDuplicatesTotal.inc({
          source: 'sqs',
        });
      } else {
        wagerOperationsTotal.inc({
          kind: data.kind,
          status: result.status,
          source: 'sqs',
        });
      }

      // Sem dados monetários completos no log.
      this.logger.log({
        action: 'wager_processed',
        correlationId: message.messageId,
        messageId: message.messageId,
        transactionId: result.transactionId,
        walletId: data.walletId,
        providerId: data.providerId,
        status: result.status,
        idempotentReplay: result.idempotentReplay,
      });
    } finally {
      stopTimer();
    }
  }
}
