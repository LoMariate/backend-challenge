import 'dotenv/config';
import {
  SQSClient,
  CreateQueueCommand,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';

const region = process.env.SQS_REGION ?? 'us-east-1';
const endpoint = process.env.SQS_ENDPOINT;

if (!endpoint) {
  throw new Error('SQS_ENDPOINT_NOT_CONFIGURED');
}

const client = new SQSClient({
  region,
  endpoint,
  maxAttempts: 1,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
  },
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry<T>(label: string, action: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 45; attempt++) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (attempt === 45) break;
      console.log(`${label}: tentando conectar ao LocalStack (${attempt}/45)`);
      await sleep(1000);
    }
  }
  throw new Error(`${label}: falhou apos repetidas tentativas`, { cause: lastError });
}

async function ensureFifoQueue(name: string): Promise<string> {
  try {
    const current = await client.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!current.QueueUrl) throw new Error(`QUEUE_URL_MISSING: ${name}`);
    return current.QueueUrl;
  } catch (error) {
    const err = error as { name?: string; Code?: string };
    const missing = [err.name, err.Code].some((value) =>
      value === 'QueueDoesNotExist' ||
      value === 'AWS.SimpleQueueService.NonExistentQueue' ||
      value === 'NonExistentQueue',
    );
    if (!missing) throw error;
    const created = await client.send(new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: 'true' },
    }));
    if (!created.QueueUrl) throw new Error(`QUEUE_CREATION_FAILED: ${name}`);
    return created.QueueUrl;
  }
}

async function main(): Promise<void> {
  const dlq = await withRetry('DLQ', () =>
    ensureFifoQueue('wager-transactions-dlq.fifo'),
  );

  const dlqAttributes = await client.send(new GetQueueAttributesCommand({
    QueueUrl: dlq,
    AttributeNames: ['QueueArn'],
  }));
  const dlqArn = dlqAttributes.Attributes?.QueueArn;
  if (!dlqArn) throw new Error('DLQ_ARN_MISSING');

  const wager = await ensureFifoQueue('wager-transactions.fifo');
  const events = await ensureFifoQueue('wager-events.fifo');

  await client.send(new SetQueueAttributesCommand({
    QueueUrl: wager,
    Attributes: {
      ContentBasedDeduplication: 'false',
      ReceiveMessageWaitTimeSeconds: '10',
      VisibilityTimeout: '120',
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: dlqArn,
        maxReceiveCount: '5',
      }),
    },
  }));
  await client.send(new SetQueueAttributesCommand({
    QueueUrl: events,
    Attributes: {
      ContentBasedDeduplication: 'true',
    },
  }));

  const expected = [
    ['SQS_WAGER_QUEUE_URL', wager],
    ['SQS_WAGER_DLQ_URL', dlq],
    ['SQS_EVENTS_QUEUE_URL', events],
  ] as const;
  for (const [envName, actualUrl] of expected) {
    const configured = process.env[envName];
    if (!configured || configured !== actualUrl) {
      throw new Error(
        `${envName} inconsistente. Configurado=${configured ?? '<vazio>'}; ` +
        `retornado_pelo_LocalStack=${actualUrl}`,
      );
    }
    console.log(`${envName}: ${actualUrl}`);
  }

  console.log('Filas de entrega verificadas com sucesso.');
}

try {
  await main();
} finally {
  client.destroy();
}
