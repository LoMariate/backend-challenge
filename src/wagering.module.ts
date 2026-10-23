import { Module } from '@nestjs/common';

import { WageringController } from
  './presentation/http/wagering.controller.js';

import { ProcessWagerTransactionUseCase } from
  './application/use-cases/process-wager-transaction.use-case.js';

import { PendingReferenceWorker } from
  './infrastructure/messaging/pending-reference.worker.js';

import { WagerQueriesController } from
  './presentation/http/wager-queries.controller.js';
  
@Module({
  controllers: [WageringController, WagerQueriesController],
  providers: [ProcessWagerTransactionUseCase, PendingReferenceWorker],
  exports: [ProcessWagerTransactionUseCase],
})
export class WageringModule {}
