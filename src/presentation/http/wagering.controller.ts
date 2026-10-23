import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  BadRequestException,
} from '@nestjs/common';


import {
  wagerOperationsTotal,
  wagerDuplicatesTotal,
  wagerProcessingDuration,
} from '../../infrastructure/observability/observability.metrics.js';


import type { Response } from 'express';

import { ProcessWagerTransactionUseCase } from
  '../../application/use-cases/process-wager-transaction.use-case.js';

import { ProcessWagerTransactionDto } from
  './process-wager-transaction.dto.js';

@Controller('wagering/transactions')
export class WageringController {
  constructor(
    private readonly processWager:
      ProcessWagerTransactionUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async create(
    @Headers('idempotency-key')
    idempotencyKey: string | undefined,

    @Body() body: ProcessWagerTransactionDto,

    @Res({ passthrough: true })
    response: Response,
  ) {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException(
        'IDEMPOTENCY_KEY_REQUIRED',
      );
    }


    const stopTimer = wagerProcessingDuration.startTimer({
      kind: body.kind,
      source: 'http',
    });

    let result: Awaited<
      ReturnType<ProcessWagerTransactionUseCase['execute']>
    >;

    try {
      result = await this.processWager.execute({
        providerId: body.providerId,
        externalTransactionId: body.externalTransactionId,
        idempotencyKey,
        playerId: body.playerId,
        walletId: body.walletId,
        roundId: body.roundId,
        gameId: body.gameId,
        kind: body.kind,
        money: body.money,
        referenceExternalTransactionId:
          body.referenceExternalTransactionId,
      });
    } finally {
      stopTimer();
    }

    if (result.idempotentReplay) {
      wagerDuplicatesTotal.inc({
        source: 'http',
      });
    } else {
      wagerOperationsTotal.inc({
        kind: body.kind,
        status: result.status,
        source: 'http',
      });
    }


    if (result.status === 'PENDING_REFERENCE') {
      response.status(HttpStatus.ACCEPTED);
    } else if (result.status === 'REJECTED') {
      response.status(HttpStatus.UNPROCESSABLE_ENTITY);
    }
    
    return result;
  }
}
