import { randomUUID } from 'node:crypto';

const baseUrl = 'http://127.0.0.1:3000';

interface WalletResponse {
  id: string;
  playerId: string;
  balance: {
    amount: string;
    currency: string;
  };
}

interface BetResponse {
  transactionId: string;
  status: 'PROCESSED' | 'REJECTED';
  balance: {
    amount: string;
    currency: string;
  };
  idempotentReplay: boolean;
  failureCode?: string;
}

async function createWallet(): Promise<WalletResponse> {
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

  if (!response.ok) {
    throw new Error(
      `Erro criando wallet: ${response.status}`,
    );
  }

  return await response.json() as WalletResponse;
}

async function sendBet(
  wallet: WalletResponse,
  externalId: string,
  amount: string,
) {
  const response = await fetch(
    `${baseUrl}/wagering/transactions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `provider-a:${externalId}`,
      },
      body: JSON.stringify({
        providerId: 'provider-a',
        externalTransactionId: externalId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'concurrency-test',
        gameId: 'game-1',
        kind: 'BET',
        money: {
          amount,
          currency: 'BRL',
        },
      }),
    },
  );

  return {
    httpStatus: response.status,
    data: await response.json() as BetResponse,
  };
}

async function main(): Promise<void> {
  // TESTE 1: Duas apostas distintas disputam saldo.
  const wallet = await createWallet();

  const results = await Promise.all([
    sendBet(wallet, randomUUID(), '80.00'),
    sendBet(wallet, randomUUID(), '80.00'),
  ]);

  console.log('Wallet:', wallet.id);
  console.log('Duas apostas:', results);

  const processed = results.filter(
    (r) =>
      r.httpStatus === 200 &&
      r.data.status === 'PROCESSED',
  );

  const rejected = results.filter(
    (r) =>
      r.httpStatus === 422 &&
      r.data.status === 'REJECTED',
  );

  if (
    processed.length !== 1 ||
    rejected.length !== 1 ||
    results.some(
      (r) => r.data.balance.amount !== '20.00',
    )
  ) {
    throw new Error('CONCURRENCY_TEST_FAILED');
  }

  console.log('✅ Concorrência: passou');

  // TESTE 2: A mesma BET chega 50 vezes.
  const wallet2 = await createWallet();
  const sameId = randomUUID();

  const duplicates = await Promise.all(
    Array.from({ length: 50 }, () =>
      sendBet(wallet2, sameId, '30.00'),
    ),
  );

  const firstExecutions = duplicates.filter(
    (r) => !r.data.idempotentReplay,
  );

  const invalidResults = duplicates.filter(
    (r) =>
      r.httpStatus !== 200 ||
      r.data.status !== 'PROCESSED' ||
      r.data.balance.amount !== '70.00',
  );

  console.log('Wallet 2:', wallet2.id);
  console.log('Respostas recebidas:', duplicates.length);
  console.log('Execuções originais:', firstExecutions.length);
  console.log('Resultados inválidos:', invalidResults.length);

  if (
    duplicates.length !== 50 ||
    firstExecutions.length !== 1 ||
    invalidResults.length !== 0
  ) {
    throw new Error('IDEMPOTENCY_TEST_FAILED');
  }

  console.log('✅ Idempotência: passou');
}

await main();
