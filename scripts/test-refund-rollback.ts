import { randomUUID } from 'node:crypto';

const baseUrl = 'http://127.0.0.1:3000';

type Kind = 'BET' | 'WIN' | 'REFUND' | 'ROLLBACK';

interface Wallet {
  id: string;
  playerId: string;
}

interface TransactionResult {
  transactionId: string;
  status: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE';
  balance: {
    amount: string;
    currency: string;
  };
  failureCode?: string;
  idempotentReplay: boolean;
}

interface Submitted {
  externalId: string;
  httpStatus: number;
  result: TransactionResult;
}

async function createWallet(): Promise<Wallet> {
  const playerId = randomUUID();

  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      playerId,
      initialBalance: {
        amount: '100.00',
        currency: 'BRL',
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`WALLET_CREATION_FAILED:${response.status}`);
  }

  const data = await response.json() as { id: string };

  return { id: data.id, playerId };
}

async function submit(
  wallet: Wallet,
  kind: Kind,
  amount: string,
  reference?: string,
  externalId: string = randomUUID(),
): Promise<Submitted> {
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
        roundId: 'round-reversal-test',
        gameId: 'game-test',
        kind,
        money: {
          amount,
          currency: 'BRL',
        },
        ...(reference
          ? { referenceExternalTransactionId: reference }
          : {}),
      }),
    },
  );

  const result =
    await response.json() as TransactionResult;

  return {
    externalId,
    httpStatus: response.status,
    result,
  };
}

function verify(
  submitted: Submitted,
  expectedStatus: TransactionResult['status'],
  expectedBalance: string,
  expectedHttp: number,
): void {
  if (
    submitted.httpStatus !== expectedHttp ||
    submitted.result.status !== expectedStatus ||
    submitted.result.balance?.amount !== expectedBalance
  ) {
    throw new Error(
      `UNEXPECTED_RESULT:${JSON.stringify(submitted)}`,
    );
  }
}

async function main(): Promise<void> {
  // CENÁRIO 1: BET -> REFUND -> ROLLBACK REFUND
  const wallet1 = await createWallet();

  const bet = await submit(wallet1, 'BET', '30.00');
  verify(bet, 'PROCESSED', '70.00', 200);

  const refund = await submit(
    wallet1,
    'REFUND',
    '30.00',
    bet.externalId,
  );
  verify(refund, 'PROCESSED', '100.00', 200);

  const replay = await submit(
    wallet1,
    'REFUND',
    '30.00',
    bet.externalId,
    refund.externalId,
  );
  verify(replay, 'PROCESSED', '100.00', 200);

  if (
    !replay.result.idempotentReplay ||
    replay.result.transactionId !==
      refund.result.transactionId
  ) {
    throw new Error('REFUND_IDEMPOTENCY_FAILED');
  }

  const rollbackRefund = await submit(
    wallet1,
    'ROLLBACK',
    '30.00',
    refund.externalId,
  );
  verify(rollbackRefund, 'PROCESSED', '70.00', 200);

  console.log('PASSOU: BET -> REFUND -> ROLLBACK REFUND');

  // CENÁRIO 2: Tentar reembolsar duas vezes.
  const duplicateRefund = await submit(
    wallet1,
    'REFUND',
    '30.00',
    bet.externalId,
  );
  verify(duplicateRefund, 'REJECTED', '70.00', 422);

  if (
    duplicateRefund.result.failureCode !==
    'REFERENCE_ALREADY_REVERSED'
  ) {
    throw new Error('DUPLICATE_REFUND_NOT_REJECTED');
  }

  console.log('PASSOU: proteção contra REFUND duplicado');

  // CENÁRIO 3: ROLLBACK direto de BET.
  const wallet2 = await createWallet();
  const bet2 = await submit(wallet2, 'BET', '20.00');
  verify(bet2, 'PROCESSED', '80.00', 200);

  const rollbackBet = await submit(
    wallet2,
    'ROLLBACK',
    '20.00',
    bet2.externalId,
  );
  verify(rollbackBet, 'PROCESSED', '100.00', 200);

  console.log('PASSOU: ROLLBACK BET');

  // CENÁRIO 4: ROLLBACK WIN sem saldo suficiente.
  const wallet3 = await createWallet();

  const win = await submit(wallet3, 'WIN', '50.00');
  verify(win, 'PROCESSED', '150.00', 200);

  const largeBet = await submit(
    wallet3,
    'BET',
    '130.00',
  );
  verify(largeBet, 'PROCESSED', '20.00', 200);

  const rollbackWin = await submit(
    wallet3,
    'ROLLBACK',
    '50.00',
    win.externalId,
  );
  verify(rollbackWin, 'REJECTED', '20.00', 422);

  if (
    rollbackWin.result.failureCode !==
    'REVERSAL_INSUFFICIENT_FUNDS'
  ) {
    throw new Error('WRONG_REVERSAL_FAILURE_CODE');
  }

  console.log('PASSOU: reversão sem saldo rejeitada');

  // CENÁRIO 5: REFUND chega antes da BET.
  const wallet4 = await createWallet();
  const lateBetId = randomUUID();

  const earlyRefund = await submit(
    wallet4,
    'REFUND',
    '25.00',
    lateBetId,
  );
  verify(earlyRefund, 'PENDING_REFERENCE', '100.00', 202);

  const replayPending = await submit(
    wallet4,
    'REFUND',
    '25.00',
    lateBetId,
    earlyRefund.externalId,
  );
  verify(
    replayPending,
    'PENDING_REFERENCE',
    '100.00',
    202,
  );

  if (!replayPending.result.idempotentReplay) {
    throw new Error('PENDING_REPLAY_FAILED');
  }

  const lateBet = await submit(
    wallet4,
    'BET',
    '25.00',
    undefined,
    lateBetId,
  );
  verify(lateBet, 'PROCESSED', '75.00', 200);

  console.log('PASSOU: referência pendente persistida');
  console.log('Wallet pendente:', wallet4.id);
  console.log(
    'Transação pendente:',
    earlyRefund.result.transactionId,
  );

  console.log(
    'Worker deverá resolver o REFUND e restaurar o saldo para 100.00',
  );

  console.log('TODOS OS TESTES HTTP PASSARAM');
}

await main();
