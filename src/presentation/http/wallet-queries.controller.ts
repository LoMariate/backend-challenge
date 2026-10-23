import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';

import { EntityManager } from '@mikro-orm/postgresql';

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

@Controller('wallets')
export class WalletQueriesController {
  constructor(
    private readonly em: EntityManager,
  ) {}

  @Get(':walletId')
  async getWallet(
    @Param('walletId', new ParseUUIDPipe())
    walletId: string,
  ) {
    const rows = await this.em.fork().execute<WalletRow[]>(
      `
      SELECT
        id,
        player_id,
        currency,
        balance,
        version,
        created_at,
        updated_at
      FROM wallets
      WHERE id = ?
      `,
      [walletId],
    );

    const wallet = rows[0];

    if (!wallet) {
      throw new NotFoundException(
        'WALLET_NOT_FOUND',
      );
    }

    return {
      id: wallet.id,
      playerId: wallet.player_id,
      balance: {
        amount: wallet.balance,
        currency: wallet.currency,
      },
      version: wallet.version,
      createdAt: wallet.created_at,
      updatedAt: wallet.updated_at,
    };
  }
}
