import 'dotenv/config';

import {
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';

import { EntityManager } from '@mikro-orm/postgresql';

import {
  SQSClient,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';

import {
  wagerDlqMessages,
  wagerOutboxLag,
  observabilityCollectionUp,
} from './observability.metrics.js';

@Injectable()
export class ObservabilitySampler
  implements OnModuleDestroy {

  private readonly logger = new Logger(
    ObservabilitySampler.name,
  );

  private readonly sqs: SQSClient;

  constructor(
    private readonly em: EntityManager,
  ) {
    this.sqs = new SQSClient({
      region: process.env.SQS_REGION ?? 'us-east-1',
      endpoint: process.env.SQS_ENDPOINT,
      credentials: process.env.SQS_ENDPOINT
        ? {
            accessKeyId:
              process.env.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey:
              process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
          }
        : undefined,
      maxAttempts: 1,
    });
  }

  async sample(): Promise<void> {
    await Promise.all([
      this.sampleOutbox(),
      this.sampleDlq(),
    ]);
  }

  private async sampleOutbox(): Promise<void> {
    try {
      const rows = await this.em.fork().execute<
        { seconds: number | string }[]
      >(
        `
        SELECT
          COALESCE(
            GREATEST(
              0,
              EXTRACT(
                EPOCH FROM (
                  NOW() - MIN(occurred_at)
                )
              )
            ),
            0
          )::double precision AS seconds
        FROM outbox_messages
        WHERE published_at IS NULL
        `,
      );

      const seconds = Number(rows[0]?.seconds ?? 0);

      if (!Number.isFinite(seconds)) {
        throw new Error('INVALID_OUTBOX_LAG');
      }

      wagerOutboxLag.set(seconds);

      observabilityCollectionUp.set(
        { component: 'postgres' },
        1,
      );
    } catch (error) {
      observabilityCollectionUp.set(
        { component: 'postgres' },
        0,
      );

      this.logger.warn('OUTBOX_METRIC_UNAVAILABLE');
    }
  }

  private async sampleDlq(): Promise<void> {
    const queueUrl = process.env.SQS_WAGER_DLQ_URL;

    if (!queueUrl) {
      observabilityCollectionUp.set(
        { component: 'sqs_dlq' },
        0,
      );

      return;
    }

    try {
      const result = await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: [
            'ApproximateNumberOfMessages',
          ],
        }),
        {
          abortSignal: AbortSignal.timeout(3000),
        },
      );

      const raw =
        result.Attributes?.ApproximateNumberOfMessages;

      if (raw === undefined) {
        throw new Error('DLQ_COUNT_UNAVAILABLE');
      }

      const count = Number(raw);

      if (!Number.isFinite(count)) {
        throw new Error('INVALID_DLQ_COUNT');
      }

      wagerDlqMessages.set(count);

      observabilityCollectionUp.set(
        { component: 'sqs_dlq' },
        1,
      );
    } catch {
      observabilityCollectionUp.set(
        { component: 'sqs_dlq' },
        0,
      );

      this.logger.warn('DLQ_METRIC_UNAVAILABLE');
    }
  }

  onModuleDestroy(): void {
    this.sqs.destroy();
  }
}
