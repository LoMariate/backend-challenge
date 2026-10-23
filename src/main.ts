import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import {
  ValidationPipe,
} from '@nestjs/common';

import { AppModule } from './app.module.js';

import { ConsoleLogger } from '@nestjs/common';

async function bootstrap() {
    const app = await NestFactory.create(AppModule, {
    logger: new ConsoleLogger({
      json: true,
    }),
  });


  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

const port = Number(process.env.PORT ?? 3000);

const host = process.env.HOST ?? '127.0.0.1';

await app.listen(port, host);

}

void bootstrap();
