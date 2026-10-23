import {
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';

import { randomUUID } from 'node:crypto';

// ==================================================
// CONFIGURACAO
// ==================================================

const PORTS = [3101, 3102, 3103] as const;

const PROVIDER_ID = 'concurrency-test-provider';

type OperationStatus =
  | 'PROCESSED'
  | 'REJECTED'
  | 'PENDING_REFERENCE';

interface Wallet {
  id: string;
  playerId: string;
}

interface WalletDetails {
  id: string;
  version: number;
  balance: {
    amount: string;
    currency: string;
  };
}

interface WagerResult {
  transactionId: string;
  status: OperationStatus;
  idempotentReplay: boolean;
  failureCode?: string | null;
  balance?: {
    amount: string;
    currency: string;
  };
}

interface Attempt {
  port: number;
  httpStatus: number;
  body: WagerResult;
}

interface LedgerResponse {
  walletId: string;
  items: {
    id: string;
    transactionId: string;
    direction: 'DEBIT' | 'CREDIT';
    money: {
      amount: string;
      currency: string;
    };
  }[];
  pageInfo: {
    hasMore: boolean;
    nextCursor: string | null;
  };
}

interface ReconciliationResult {
  walletId: string;
  consistent: boolean;
  difference: {
    amount: string;
    currency: string;
  };
  checkedEntries: number;
}

// ==================================================
// FUNCOES HTTP
// ==================================================

function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function getJson<T>(
  port: number,
  path: string,
): Promise<T> {
  const response = await fetch(
    `${baseUrl(port)}${path}`,
    {
      signal: AbortSignal.timeout(30000),
    },
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `GET ${path} HTTP ${response.status}: ${text}`,
    );
  }

  return JSON.parse(text) as T;
}

async function createWallet(
  amount = '100.00',
): Promise<Wallet> {
  const playerId = randomUUID();

  const response = await fetch(
    `${baseUrl(PORTS[0])}/wallets`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        playerId,
        initialBalance: {
          amount,
          currency: 'BRL',
        },
      }),
      signal: AbortSignal.timeout(30000),
    },
  );

  const text = await response.text();

  if (response.status !== 201) {
    throw new Error(
      `CREATE_WALLET_FAILED: HTTP ${response.status}: ${text}`,
    );
  }

  const result = JSON.parse(text) as { id: string };

  return {
    id: result.id,
    playerId,
  };
}

async function submitBet(
  port: number,
  wallet: Wallet,
  externalTransactionId: string,
  amount: string,
): Promise<Attempt> {
  const idempotencyKey =
    `${PROVIDER_ID}:${externalTransactionId}`;

  const response = await fetch(
    `${baseUrl(port)}/wagering/transactions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        providerId: PROVIDER_ID,
        externalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'concurrency-round',
        gameId: 'concurrency-game',
        kind: 'BET',
        money: {
          amount,
          currency: 'BRL',
        },
      }),
      signal: AbortSignal.timeout(90000),
    },
  );

  const text = await response.text();

  let body: WagerResult;

  try {
    body = JSON.parse(text) as WagerResult;
  } catch {
    throw new Error(
      `INVALID_HTTP_RESPONSE port=${port} status=${response.status}: ${text}`,
    );
  }

  return {
    port,
    httpStatus: response.status,
    body,
  };
}

// ==================================================
// CONSULTAS DE VERIFICACAO
// ==================================================

async function getWallet(
  walletId: string,
): Promise<WalletDetails> {
  return getJson<WalletDetails>(
    PORTS[1],
    `/wallets/${walletId}`,
  );
}

async function getLedger(
  walletId: string,
): Promise<LedgerResponse> {
  return getJson<LedgerResponse>(
    PORTS[2],
    `/wallets/${walletId}/ledger?limit=100`,
  );
}

async function reconcile(
  walletId: string,
): Promise<ReconciliationResult> {
  const response = await fetch(
    `${baseUrl(PORTS[1])}/wallets/${walletId}/reconciliation`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
    },
  );

  const text = await response.text();

  if (response.status !== 200) {
    throw new Error(
      `RECONCILIATION_FAILED: HTTP ${response.status}: ${text}`,
    );
  }

  return JSON.parse(text) as ReconciliationResult;
}

async function assertConsistent(
  walletId: string,
  expectedBalance: string,
  expectedVersion: number,
  expectedLedgerEntries: number,
): Promise<void> {
  const wallet = await getWallet(walletId);

  expect(wallet.balance.amount)
    .toBe(expectedBalance);

  expect(wallet.balance.currency)
    .toBe('BRL');

  expect(wallet.version)
    .toBe(expectedVersion);

  const ledger = await getLedger(walletId);

  // Nenhum teste desta etapa possui
  // mais de 100 lancamentos por wallet.
  expect(ledger.pageInfo.hasMore).toBe(false);

  expect(ledger.items.length)
    .toBe(expectedLedgerEntries);

  const uniqueIds = new Set(
    ledger.items.map((entry) => entry.id),
  );

  expect(uniqueIds.size)
    .toBe(ledger.items.length);

  const reconciliation = await reconcile(walletId);

  expect(reconciliation.consistent)
    .toBe(true);

  expect(reconciliation.difference.amount)
    .toBe('0.00');

  expect(reconciliation.checkedEntries)
    .toBe(expectedLedgerEntries);
}

// ==================================================
// TESTES DISTRIBUIDOS
// ==================================================

describe('Concorrencia distribuida - 3 processos reais', () => {

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;

    // Impede execução acidental contra o banco normal.
    if (
      !databaseUrl ||
      new URL(databaseUrl).pathname !==
        '/backend_challenge_test'
    ) {
      throw new Error(
        'CONCURRENCY_TEST_REQUIRES_TEST_DATABASE',
      );
    }

    // Comprovar que as 3 instancias respondem
    // e estao prontas para receber operacoes.
    for (const port of PORTS) {
      const health = await getJson<{
        status: string;
      }>(
        port,
        '/health/ready',
      );

      expect(health.status).toBe('ok');
    }
  }, 30000);

  // ================================================
  // TESTE 1 - 50 BETS IDENTICAS SIMULTANEAS
  // ================================================

  test(
    '50 apostas identicas produzem apenas 1 debito',
    async () => {
      const wallet = await createWallet('100.00');

      const externalId = randomUUID();

      // Criar 50 chamadas para a MESMA BET.
      const requests = Array.from(
        { length: 50 },
        (_, index) => {
          const port = PORTS[index % PORTS.length];

          return submitBet(
            port,
            wallet,
            externalId,
            '25.00',
          );
        },
      );

      // Disparar todas concorrentemente.
      const results = await Promise.all(requests);

      expect(results).toHaveLength(50);

      // Todas devem receber uma resposta financeira
      // definitiva, sem erros inesperados.
      const failures = results
        .filter(
          (result) =>
            result.httpStatus !== 200 ||
            result.body.status !== 'PROCESSED',
        )
        .map((result) => ({
          port: result.port,
          httpStatus: result.httpStatus,
          body: result.body,
        }));

      expect(failures).toEqual([]);

      // Todas devem apontar para a MESMA transacao.
      const transactionIds = new Set(
        results.map((result) =>
          result.body.transactionId,
        ),
      );

      expect(transactionIds.size).toBe(1);

      // Apenas uma chamada cria a operacao.
      const originals = results.filter(
        (result) =>
          result.body.idempotentReplay === false,
      );

      const replays = results.filter(
        (result) =>
          result.body.idempotentReplay === true,
      );

      expect(originals).toHaveLength(1);
      expect(replays).toHaveLength(49);

      // OPENING 100.00 - BET 25.00 = 75.00
      await assertConsistent(
        wallet.id,
        '75.00',
        2,
        2,
      );

      const ledger = await getLedger(wallet.id);

      const debits = ledger.items.filter(
        (entry) =>
          entry.direction === 'DEBIT',
      );

      expect(debits).toHaveLength(1);
      expect(debits[0]?.money.amount).toBe('25.00');

      // Verificar que a consulta externa aponta
      // para o mesmo registro processado.
      const transaction = await getJson<WagerResult>(
        PORTS[2],
        `/providers/${PROVIDER_ID}/wagering/transactions/${externalId}`,
      );

      expect(transaction.transactionId)
        .toBe(originals[0]?.body.transactionId);

      expect(transaction.status).toBe('PROCESSED');

      console.log(
        'PASSOU: 50 envios, 1 operacao, 49 replays, 1 debito.',
      );
    },
    120000,
  );

  // ================================================
  // TESTE 2 - DUAS BETS DE 80 SOBRE SALDO 100
  // ================================================

  test(
    'duas apostas disputam o mesmo saldo sem ficar negativo',
    async () => {
      const wallet = await createWallet('100.00');

      const betAId = randomUUID();
      const betBId = randomUUID();

      // Transacoes DIFERENTES, com IDs
      // e chaves de idempotencia diferentes.
      const [a, b] = await Promise.all([
        submitBet(
          PORTS[0],
          wallet,
          betAId,
          '80.00',
        ),
        submitBet(
          PORTS[1],
          wallet,
          betBId,
          '80.00',
        ),
      ]);

      const results = [a, b];

      const httpStatuses = results
        .map((result) => result.httpStatus)
        .sort((x, y) => x - y);

      expect(httpStatuses).toEqual([200, 422]);

      const statuses = results
        .map((result) => result.body.status)
        .sort();

      expect(statuses).toEqual([
        'PROCESSED',
        'REJECTED',
      ]);

      const rejected = results.find(
        (result) =>
          result.body.status === 'REJECTED',
      );

      expect(rejected?.body.failureCode)
        .toBe('INSUFFICIENT_FUNDS');

      await assertConsistent(
        wallet.id,
        '20.00',
        2,
        2,
      );

      // OPENING + um unico DEBIT.
      const ledger = await getLedger(wallet.id);

      const debits = ledger.items.filter(
        (entry) =>
          entry.direction === 'DEBIT',
      );

      expect(debits).toHaveLength(1);
      expect(debits[0]?.money.amount).toBe('80.00');

      console.log(
        'PASSOU: uma BET processada, outra rejeitada, saldo 20.00.',
      );
    },
    60000,
  );

  // ================================================
  // TESTE 3 - WALLETS DIFERENTES EM PARALELO
  // ================================================

  test(
    'wallets diferentes recebem operacoes simultaneas',
    async () => {
      // Nove wallets independentes.
      const wallets = await Promise.all(
        Array.from(
          { length: 9 },
          () => createWallet('100.00'),
        ),
      );

      // Duas BETs diferentes por wallet:
      // 100 - 10 - 5 = 85.
      const requests = wallets.flatMap(
        (wallet, walletIndex) => [
          submitBet(
            PORTS[walletIndex % PORTS.length],
            wallet,
            randomUUID(),
            '10.00',
          ),
          submitBet(
            PORTS[
              (walletIndex + 1) % PORTS.length
            ],
            wallet,
            randomUUID(),
            '5.00',
          ),
        ],
      );

      // 18 operacoes disparadas concorrentemente.
      const results = await Promise.all(requests);

      expect(results).toHaveLength(18);

      const failures = results.filter(
        (result) =>
          result.httpStatus !== 200 ||
          result.body.status !== 'PROCESSED' ||
          result.body.idempotentReplay !== false,
      );

      expect(failures).toEqual([]);

      // Cada wallet deve ter:
      // versao 3, 3 entradas e saldo 85.
      for (const wallet of wallets) {
        await assertConsistent(
          wallet.id,
          '85.00',
          3,
          3,
        );

        const ledger = await getLedger(wallet.id);

        expect(
          ledger.items.filter(
            (entry) =>
              entry.direction === 'DEBIT',
          ),
        ).toHaveLength(2);
      }

      console.log(
        'PASSOU: 9 wallets, 18 BETs, todas reconciliadas.',
      );
    },
    120000,
  );

});
