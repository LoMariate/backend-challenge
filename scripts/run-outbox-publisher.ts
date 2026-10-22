import 'reflect-metadata';
import 'dotenv/config';

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';

import { AppModule } from '../src/app.module.js';

import { OutboxPublisher } from
  '../src/infrastructure/messaging/outbox.publisher.js';

const logger = new Logger('OutboxWorker');

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(
    AppModule,
  );

  const publisher = app.get(OutboxPublisher);

  let running = true;

  process.once('SIGINT', () => {
    running = false;
  });

  process.once('SIGTERM', () => {
    running = false;
  });

  logger.log('Outbox worker iniciado');

  try {
    while (running) {
      try {
        const processed = await publisher.publishBatch();

        if (processed > 0) {
          logger.log(
            `Lote executado: ${processed} eventos`,
          );
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'UNKNOWN_ERROR';

        logger.error(`Erro no worker: ${message}`);
      }

      if (running) {
        await sleep(1000);
      }
    }
  } finally {
    logger.log('Encerrando Outbox worker');
    await app.close();
  }
}

void bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
