import { Module } from '@nestjs/common';

import { CreateWalletUseCase } from
  './application/use-cases/create-wallet.use-case.js';

import { WalletCreationRepository } from
  './infrastructure/persistence/repositories/wallet-creation.repository.js';

import { WalletsController } from
  './presentation/http/wallets.controller.js';

import { WalletQueriesController } from
  './presentation/http/wallet-queries.controller.js';

import { WalletLedgerController } from
  './presentation/http/wallet-ledger.controller.js';  

@Module({
  controllers: [WalletsController, WalletQueriesController, WalletLedgerController],
  providers: [
    CreateWalletUseCase,
    WalletCreationRepository,
  ],
})
export class WalletsModule {}
