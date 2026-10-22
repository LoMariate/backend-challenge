import { Module } from '@nestjs/common';

import { CreateWalletUseCase } from
  './application/use-cases/create-wallet.use-case.js';

import { WalletCreationRepository } from
  './infrastructure/persistence/repositories/wallet-creation.repository.js';

import { WalletsController } from
  './presentation/http/wallets.controller.js';

@Module({
  controllers: [WalletsController],
  providers: [
    CreateWalletUseCase,
    WalletCreationRepository,
  ],
})
export class WalletsModule {}
