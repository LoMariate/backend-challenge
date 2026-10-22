
import 'reflect-metadata';
import 'dotenv/config';

import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

import { ReflectMetadataProvider } from
  '@mikro-orm/decorators/legacy';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL não foi configurada no .env',
  );
}

export default defineConfig({
  clientUrl: databaseUrl,

  // Arquivos JavaScript compilados
  entities: [
    './dist/infrastructure/persistence/entities/*.orm-entity.js',
  ],

  // Arquivos TypeScript de desenvolvimento
  entitiesTs: [
    './src/infrastructure/persistence/entities/*.orm-entity.ts',
  ],

  metadataProvider: ReflectMetadataProvider,

  extensions: [Migrator],

  migrations: {
    path: './migrations',
    pathTs: './migrations',
    emit: 'ts',
    transactional: true,
    allOrNothing: true,
  },
});
