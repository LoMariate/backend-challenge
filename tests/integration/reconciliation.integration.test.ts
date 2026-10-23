import 'reflect-metadata';
import 'dotenv/config';

import {
  beforeAll,
  afterAll,
  describe,
  expect,
  test,
} from 'bun:test';

import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import {
  type INestApplication,
} from '@nestjs/common';

import { NestFactory } from '@nestjs/core';
import { EntityManager } from '@mikro-orm/postgresql';

import { AppModule } from
  '../../src/app.module.js';

let app: INestApplication;
let em: EntityManager;
let baseUrl = '';

interface ReconciliationResponse {
  walletId: string;
  storedBalance: {
    amount: string;
    currency: string;
  };
  calculatedBalance: {
    amount: string;
    currency: string;
  };
  difference: {
    amount: string;
    currency: string;
  };
  consistent: boolean;
  checkedEntries: number;
}

async function reconcile(
  walletId: string,
): Promise<ReconciliationResponse> {
  const response = await fetch(
    `${baseUrl}/wallets/${walletId}/reconciliation`,
    { method: 'POST' },
  );

  expect(response.status).toBe(200);

  return await response.json() as ReconciliationResponse;
}

describe('Wallet Reconciliation - PostgreSQL real', () => {
  beforeAll(async () => {
    const url = process.env.DATABASE_URL;

    // Não permitir execução no banco principal.
    if (
      !url ||
      new URL(url).pathname !==
        '/backend_challenge_test'
    ) {
      throw new Error(
        'RECONCILIATION_TEST_REQUIRES_TEST_DATABASE',
      );
    }

    app = await NestFactory.create(AppModule, {
      logger: false,
    });

    await app.listen(0, '127.0.0.1');

    const address =
      app.getHttpServer().address() as AddressInfo;

    baseUrl = `http://127.0.0.1:${address.port}`;

    em = app.get(EntityManager);
  }, 30000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  test(
    'detecta divergencia e nao corrige automaticamente',
    async () => {
      const response = await fetch(`${baseUrl}/wallets`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          playerId: randomUUID(),
          initialBalance: {
            amount: '100.00',
            currency: 'BRL',
          },
        }),
      });

      expect(response.status).toBe(201);

      const wallet =
        await response.json() as { id: string };

      // Conferir estado inicial.
      const initial = await reconcile(wallet.id);

      expect(initial.consistent).toBe(true);
      expect(initial.difference.amount).toBe('0.00');
      expect(initial.checkedEntries).toBe(1);

      // SIMULAÇÃO DE CORRUPÇÃO — SOMENTE NO TEST DB.
      // A aplicação normal nunca deve fazer isso.
      await em.fork().execute(
        `
        UPDATE wallets
        SET balance = balance + 1.00
        WHERE id = ?
        `,
        [wallet.id],
      );

      try {
        const divergent = await reconcile(wallet.id);

        expect(divergent.consistent).toBe(false);
        expect(divergent.storedBalance.amount)
          .toBe('101.00');
        expect(divergent.calculatedBalance.amount)
          .toBe('100.00');
        expect(divergent.difference.amount)
          .toBe('1.00');

        // Confirmar que a rota não alterou o saldo.
        const rows = await em.fork().execute<
          { balance: string }[]
        >(
          `
          SELECT balance::text AS balance
          FROM wallets
          WHERE id = ?
          `,
          [wallet.id],
        );

        expect(rows[0]?.balance).toBe('101.00');

        // Confirmar incremento da métrica.
        const metrics = await fetch(`${baseUrl}/metrics`);

        expect(metrics.status).toBe(200);

        const content = await metrics.text();

        expect(content).toContain(
          'wallet_reconciliation_checks_total',
        );

        expect(content).toContain(
          'result="divergent"',
        );
      } finally {
        // Restaurar a wallet isolada,
        // mesmo se uma asserção falhar.
        await em.fork().execute(
          `
          UPDATE wallets
          SET balance = balance - 1.00
          WHERE id = ?
          `,
          [wallet.id],
        );
      }

      const restored = await reconcile(wallet.id);

      expect(restored.consistent).toBe(true);
      expect(restored.difference.amount).toBe('0.00');
    },
    30000,
  );

  test('retorna 404 para wallet inexistente', async () => {
    const response = await fetch(
      `${baseUrl}/wallets/11111111-1111-4111-8111-111111111111/reconciliation`,
      { method: 'POST' },
    );

    expect(response.status).toBe(404);
  });
});
