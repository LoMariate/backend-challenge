import { Module } from '@nestjs/common';

import {
  WAGER_MESSAGE_HANDLER,
} from './application/ports/wager-message-handler.js';

import {
  WageringModule,
} from './wagering.module.js';

import {
  OutboxPublisher,
} from './infrastructure/messaging/outbox.publisher.js';

import {
  WagerTransactionsConsumer,
} from './infrastructure/messaging/wager-transactions.consumer.js';

import {
  SqsWagerMessageHandler,
} from './infrastructure/messaging/sqs-wager-message.handler.js';

@Module({
  imports: [WageringModule],
  providers: [
    OutboxPublisher,

    {
      provide: WAGER_MESSAGE_HANDLER,
      useClass: SqsWagerMessageHandler,
    },

    WagerTransactionsConsumer,
  ],
  exports: [
    OutboxPublisher,
    WagerTransactionsConsumer,
  ],
})
export class MessagingModule {}
