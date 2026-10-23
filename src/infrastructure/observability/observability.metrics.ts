import {
  Counter,
  Gauge,
  Histogram,
} from 'prom-client';

export const wagerOperationsTotal = new Counter({
  name: 'wager_operations_total',
  help: 'Operacoes financeiras recebidas pela aplicacao',
  labelNames: ['kind', 'status', 'source'] as const,
});

export const wagerDuplicatesTotal = new Counter({
  name: 'wager_duplicates_total',
  help: 'Replays financeiros idempotentes detectados',
  labelNames: ['source'] as const,
});

export const wagerRetriesTotal = new Counter({
  name: 'wager_retries_total',
  help: 'Tentativas de reprocessamento agendadas',
  labelNames: ['component'] as const,
});

export const wagerLockConflictsTotal = new Counter({
  name: 'wager_lock_conflicts_total',
  help: 'Conflitos de atualizacao da wallet detectados',
  labelNames: ['reason'] as const,
});

export const wagerProcessingDuration = new Histogram({
  name: 'wager_processing_duration_seconds',
  help: 'Duracao do processamento financeiro em segundos',
  labelNames: ['kind', 'source'] as const,
  buckets: [
    0.005,
    0.01,
    0.025,
    0.05,
    0.1,
    0.25,
    0.5,
    1,
    2,
    5,
    10,
  ],
});

export const wagerDlqMessages = new Gauge({
  name: 'wager_dlq_messages',
  help: 'Quantidade aproximada de mensagens na DLQ',
});

export const wagerOutboxLag = new Gauge({
  name: 'wager_outbox_lag_seconds',
  help: 'Idade em segundos do evento pendente mais antigo',
});

export const observabilityCollectionUp = new Gauge({
  name: 'observability_collection_up',
  help: 'Estado da coleta das metricas externas',
  labelNames: ['component'] as const,
});
