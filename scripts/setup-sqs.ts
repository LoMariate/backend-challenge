import 'dotenv/config';

import {
  SQSClient,
  CreateQueueCommand,
} from '@aws-sdk/client-sqs';

const client = new SQSClient({
  region: 'us-east-1',
  endpoint: 'http://localhost:4566',
  credentials: {
    accessKeyId: 'test',
    secretAccessKey: 'test',
  },
});

async function main(): Promise<void> {
  const result = await client.send(
    new CreateQueueCommand({
      QueueName: 'wager-events.fifo',
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
      },
    }),
  );

  console.log('Fila criada:', result.QueueUrl);
}

try {
  await main();
} finally {
  client.destroy();
}
