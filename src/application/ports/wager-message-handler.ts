import type { MoneyProps } from
  '../../domain/value-objects/money.js';

export type ExternalWagerKind =
  | 'BET'
  | 'WIN'
  | 'LOSS'
  | 'REFUND'
  | 'ROLLBACK';

export interface WagerTransactionRequested {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;

  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: ExternalWagerKind;
    money: MoneyProps;
    referenceExternalTransactionId?: string;
  };
}

export const WAGER_MESSAGE_HANDLER =
  Symbol('WAGER_MESSAGE_HANDLER');

export interface WagerMessageHandler {
  // Só resolve quando o processamento financeiro
  // e a Inbox estiverem confirmados no PostgreSQL.
  handle(
    message: WagerTransactionRequested,
  ): Promise<void>;
}
