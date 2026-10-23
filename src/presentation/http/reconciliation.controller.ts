import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';

import {
  ReconcileWalletUseCase,
} from '../../application/use-cases/reconcile-wallet.use-case.js';

@Controller('wallets')
export class ReconciliationController {
  constructor(
    private readonly reconcileWallet:
      ReconcileWalletUseCase,
  ) {}

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcile(
    @Param(
      'walletId',
      new ParseUUIDPipe({ version: 'all' }),
    )
    walletId: string,
  ) {
    return this.reconcileWallet.execute(walletId);
  }
}
