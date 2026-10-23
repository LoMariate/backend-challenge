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

import { ReconcileWalletUseCase } from
  './application/use-cases/reconcile-wallet.use-case.js';

import { ReconciliationController } from
  './presentation/http/reconciliation.controller.js';

import { MetricsController } from
  './presentation/http/metrics.controller.js';

@Module({
  controllers: [WalletsController, WalletQueriesController, WalletLedgerController, ReconciliationController, MetricsController],
  providers: [
    CreateWalletUseCase,
    WalletCreationRepository,
    ReconcileWalletUseCase,
  ],
})
export class WalletsModule {}
