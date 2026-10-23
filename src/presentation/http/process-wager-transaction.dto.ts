import {
  IsIn,
  IsNotEmpty,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
  IsOptional,
} from 'class-validator';

import { Type } from 'class-transformer';

import { MoneyDto } from './create-wallet.dto.js';

export class ProcessWagerTransactionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  providerId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  externalTransactionId!: string;

  @IsUUID('all')
  playerId!: string;

  @IsUUID('all')
  walletId!: string;

  @IsString()
  @IsNotEmpty()
  roundId!: string;

  @IsString()
  @IsNotEmpty()
  gameId!: string;

  @IsIn(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'])
  kind!: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  referenceExternalTransactionId?: string;

  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;
}
