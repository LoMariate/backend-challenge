import 'dotenv/config';

import {
  Injectable,
  OnModuleDestroy,
} from '@nestjs/common';

import { EntityManager } from '@mikro-orm/postgresql';

import {
  SQSClient,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';

type DependencyStatus = 'up' | 'down';

export interface ReadinessResult {
  status: 'ok' | 'error';
  checks: {
    postgres: DependencyStatus;
    wagerQueue: DependencyStatus;
    eventsQueue: DependencyStatus;
    wagerDlq: DependencyStatus;
  };
}

@Injectable()
export class HealthService implements OnModuleDestroy {
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

  private async checkPostgres(): Promise<boolean> {
    try {
      const rows = await this.em.fork().execute<
        { healthy: number }[]
      >('SELECT 1 AS healthy');

      return Number(rows[0]?.healthy) === 1;
    } catch {
      return false;
    }
  }

  private async checkQueue(
    queueUrl: string | undefined,
  ): Promise<boolean> {
    if (!queueUrl) {
      return false;
    }

    try {
      const response = await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: ['QueueArn'],
        }),
        {
          abortSignal: AbortSignal.timeout(3000),
        },
      );

      return Boolean(response.Attributes?.QueueArn);
    } catch {
      return false;
    }
  }

  async readiness(): Promise<ReadinessResult> {
    const [
      postgres,
      wagerQueue,
      eventsQueue,
      wagerDlq,
    ] = await Promise.all([
      this.checkPostgres(),
      this.checkQueue(process.env.SQS_WAGER_QUEUE_URL),
      this.checkQueue(process.env.SQS_EVENTS_QUEUE_URL),
      this.checkQueue(process.env.SQS_WAGER_DLQ_URL),
    ]);

    const allReady =
      postgres &&
      wagerQueue &&
      eventsQueue &&
      wagerDlq;

    return {
      status: allReady ? 'ok' : 'error',
      checks: {
        postgres: postgres ? 'up' : 'down',
        wagerQueue: wagerQueue ? 'up' : 'down',
        eventsQueue: eventsQueue ? 'up' : 'down',
        wagerDlq: wagerDlq ? 'up' : 'down',
      },
    };
  }

  onModuleDestroy(): void {
    this.sqs.destroy();
  }
}
