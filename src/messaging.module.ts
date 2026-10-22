import { Module } from '@nestjs/common';

import { OutboxPublisher } from
  './infrastructure/messaging/outbox.publisher.js';

@Module({
  providers: [OutboxPublisher],
  exports: [OutboxPublisher],
})
export class MessagingModule {}
