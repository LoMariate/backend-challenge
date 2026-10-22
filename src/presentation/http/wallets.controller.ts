import {
  Body,
  Controller,
  Post,
} from '@nestjs/common';

import { CreateWalletUseCase } from
  '../../application/use-cases/create-wallet.use-case.js';

import { CreateWalletDto } from
  './create-wallet.dto.js';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
  ) {}

  @Post()
  async create(@Body() body: CreateWalletDto) {
    return this.createWallet.execute({
      playerId: body.playerId,
      initialBalance: body.initialBalance,
    });
  }
}
