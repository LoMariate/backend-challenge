import 'reflect-metadata';
import 'dotenv/config';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module.js';

import { ConsoleLogger } from '@nestjs/common';

import { PendingReferenceWorker } from
  '../src/infrastructure/messaging/pending-reference.worker.js';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(
    AppModule,
    {
      logger: new ConsoleLogger({
        json: true,
      }),
    },
  );



  const worker = app.get(PendingReferenceWorker);

  let running = true;

  process.once('SIGINT', () => {
    running = false;
  });

  process.once('SIGTERM', () => {
    running = false;
  });

  console.log('Pending Reference Worker iniciado');

  try {
    while (running) {
      try {
        await worker.runBatch();
      } catch (error) {
        console.error(
          'Erro no worker de referências:',
          error,
        );
      }

      if (running) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, 1000),
        );
      }
    }
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
