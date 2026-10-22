import 'dotenv/config';

import {
  SQSClient,
  CreateQueueCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';

const sqs = new SQSClient({
  region: process.env.SQS_REGION ?? 'us-east-1',
  endpoint:
    process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
  credentials: {
    accessKeyId: 'test',
    secretAccessKey: 'test',
  },
});

async function main(): Promise<void> {
  // 1. Criar a Dead Letter Queue
  const dlq = await sqs.send(
    new CreateQueueCommand({
      QueueName: 'wager-transactions-dlq.fifo',
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        MessageRetentionPeriod: '1209600',
      },
    }),
  );

  if (!dlq.QueueUrl) {
    throw new Error('DLQ_URL_NOT_RETURNED');
  }

  // 2. Descobrir o ARN da DLQ
  const attributes = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlq.QueueUrl,
      AttributeNames: ['QueueArn'],
    }),
  );

  const dlqArn = attributes.Attributes?.QueueArn;

  if (!dlqArn) {
    throw new Error('DLQ_ARN_NOT_RETURNED');
  }

  // 3. Criar a fila principal
  const mainQueue = await sqs.send(
    new CreateQueueCommand({
      QueueName: 'wager-transactions.fifo',
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: '120',
        ReceiveMessageWaitTimeSeconds: '10',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: '5',
        }),
      },
    }),
  );

  if (!mainQueue.QueueUrl) {
    throw new Error('WAGER_QUEUE_URL_NOT_RETURNED');
  }

  console.log('Fila principal:', mainQueue.QueueUrl);
  console.log('DLQ:', dlq.QueueUrl);
  console.log('Limite de recebimentos: 5');
}

try {
  await main();
} finally {
  sqs.destroy();
}
