import { Counter, register } from 'prom-client';

export const reconciliationChecks = new Counter({
  name: 'wallet_reconciliation_checks_total',
  help: 'Total de verificacoes de reconciliacao de wallets',
  labelNames: ['result'] as const,
});

export { register as metricsRegistry };
