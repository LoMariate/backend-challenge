import 'dotenv/config';

import {
  SQSClient,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';

const queueUrl = process.env.SQS_EVENTS_QUEUE_URL;

if (!queueUrl) {
  throw new Error('SQS_EVENTS_QUEUE_URL_NOT_CONFIGURED');
}

const client = new SQSClient({
  region: process.env.SQS_REGION ?? 'us-east-1',
  endpoint: process.env.SQS_ENDPOINT,
  credentials: {
    accessKeyId: 'test',
    secretAccessKey: 'test',
  },
});

try {
  const result = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages'],
    }),
  );

  console.log(
    'Mensagens disponíveis:',
    result.Attributes?.ApproximateNumberOfMessages ?? '0',
  );
} finally {
  client.destroy();
}
