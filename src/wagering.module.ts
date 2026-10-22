import { Module } from '@nestjs/common';

import { WageringController } from
  './presentation/http/wagering.controller.js';

import { ProcessWagerTransactionUseCase } from
  './application/use-cases/process-wager-transaction.use-case.js';

@Module({
  controllers: [WageringController],
  providers: [ProcessWagerTransactionUseCase],
  exports: [ProcessWagerTransactionUseCase],
})
export class WageringModule {}
