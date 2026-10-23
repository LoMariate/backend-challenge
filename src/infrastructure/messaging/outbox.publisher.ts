import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

import { randomUUID } from 'node:crypto';

import { EntityManager } from '@mikro-orm/postgresql';

import {
  wagerRetriesTotal,
} from '../observability/observability.metrics.js';

import {
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';

interface ClaimedOutboxEvent {
  id: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  claim_token: string;
}

@Injectable()
export class OutboxPublisher implements OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisher.name);

  private readonly sqs: SQSClient;
  private readonly queueUrl: string;

  constructor(
    private readonly em: EntityManager,
  ) {
    const queueUrl = process.env.SQS_EVENTS_QUEUE_URL;

    if (!queueUrl) {
      throw new Error('SQS_EVENTS_QUEUE_URL_NOT_CONFIGURED');
    }

    this.queueUrl = queueUrl;

    this.sqs = new SQSClient({
      region: process.env.SQS_REGION ?? 'us-east-1',
      endpoint: process.env.SQS_ENDPOINT,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
      maxAttempts: 2,
    });
  }

  // Reserva eventos sem manter o lock durante o envio ao SQS.
  private async claimBatch(
    batchSize = 10,
  ): Promise<ClaimedOutboxEvent[]> {
    const token = randomUUID();

    const em = this.em.fork();

    return em.transactional(async (tx) => {
      return tx.execute<ClaimedOutboxEvent[]>(
        `
        WITH candidates AS (
          SELECT id
          FROM outbox_messages
          WHERE published_at IS NULL
            AND (
              next_attempt_at IS NULL
              OR next_attempt_at <= NOW()
            )
            AND (
              lease_until IS NULL
              OR lease_until <= NOW()
            )
          ORDER BY occurred_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT :batchSize
        )
        UPDATE outbox_messages AS o
        SET
          claim_token = :token,
          lease_until = NOW() + INTERVAL '2 minutes'
        FROM candidates AS c
        WHERE o.id = c.id
        RETURNING
          o.id,
          o.aggregate_id,
          o.payload,
          o.claim_token
        `,
        { token, batchSize },
      );
    });
  }

  // Confirma publicação apenas se a reserva
  // ainda pertence a este publisher.
  private async markPublished(
    event: ClaimedOutboxEvent,
  ): Promise<void> {
    await this.em.fork().execute(
      `
      UPDATE outbox_messages
      SET
        published_at = NOW(),
        next_attempt_at = NULL,
        claim_token = NULL,
        lease_until = NULL
      WHERE id = :id
        AND claim_token = :token
        AND published_at IS NULL
      `,
      {
        id: event.id,
        token: event.claim_token,
      },
    );
  }

  // Agenda retry com backoff exponencial.
  private async scheduleRetry(
    event: ClaimedOutboxEvent,
  ): Promise<void> {
    await this.em.fork().execute(
      `
      UPDATE outbox_messages
      SET
        attempts = attempts + 1,
        next_attempt_at = NOW() +
          make_interval(
            secs => LEAST(
              300,
              (1 << LEAST(attempts, 9))
            )
          ),
        claim_token = NULL,
        lease_until = NULL
      WHERE id = :id
        AND claim_token = :token
        AND published_at IS NULL
      `,
      {
        id: event.id,
        token: event.claim_token,
      },
    );
  }

  // Executa um ciclo de publicação.
  async publishBatch(): Promise<number> {
    const events = await this.claimBatch();

    for (const event of events) {
      try {
        const result = await this.sqs.send(
          new SendMessageCommand({
            QueueUrl: this.queueUrl,
            MessageBody: JSON.stringify(event.payload),
            MessageGroupId: event.aggregate_id,
            MessageDeduplicationId: event.id,
          }),
          {
            abortSignal: AbortSignal.timeout(15_000),
          },
        );

        if (!result.MessageId) {
          throw new Error('SQS_MESSAGE_ID_MISSING');
        }

        await this.markPublished(event);

        this.logger.log(`Outbox publicada: ${event.id}`);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'UNKNOWN_ERROR';

        this.logger.warn(
          `Falha na publicação/confirmação ${event.id}: ${message}`,
        );

        try {
          await this.scheduleRetry(event);          
          wagerRetriesTotal.inc({
            component: 'outbox',
          });
        } catch {
          // Se o PostgreSQL estiver indisponível,
          // o lease expira e outra instância poderá tentar.
          this.logger.error(
            `Não foi possível agendar retry: ${event.id}`,
          );
        }
      }
    }

    return events.length;
  }

  onModuleDestroy(): void {
    this.sqs.destroy();
  }
}
