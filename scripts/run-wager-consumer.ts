import 'reflect-metadata';
import 'dotenv/config';

import { ConsoleLogger } from '@nestjs/common';

import { NestFactory } from '@nestjs/core';

import {
  AppModule,
} from '../src/app.module.js';

import {
  WagerTransactionsConsumer,
} from '../src/infrastructure/messaging/wager-transactions.consumer.js';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(
    AppModule,
    {
      logger: new ConsoleLogger({
        json: true,
      }),
    },
  );


  const consumer = app.get(WagerTransactionsConsumer);

  let running = true;

  const stop = (): void => {
    running = false;
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  console.log('Wager SQS Consumer iniciado');

  try {
    while (running) {
      try {
        await consumer.pollOnce();
      } catch (error) {
        console.error('Erro no ciclo SQS:', error);

        // Evita loop intenso se SQS estiver indisponível.
        if (running) {
          await sleep(1000);
        }
      }
    }
  } finally {
    console.log('Encerrando Wager SQS Consumer');

    await app.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
