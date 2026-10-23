# Backend Challenge — Distributed Wagering Wallet

Serviço financeiro distribuído para carteiras de jogadores e transações de apostas de múltiplos provedores. O projeto prioriza **consistência monetária**, **idempotência persistente**, **concorrência entre instâncias**, **processamento assíncrono com recuperação após falhas** e **rastreabilidade via ledger imutável**.

## Stack

- Bun 1.x (runtime, gerenciador de pacotes e test runner) e TypeScript em modo estrito.
- NestJS (API HTTP e injeção de dependências).
- PostgreSQL 16 e MikroORM 7 com migrations versionadas.
- AWS SQS FIFO no LocalStack; AWS SDK v3.
- `decimal.js` para o domínio monetário; PostgreSQL `NUMERIC` para persistência.
- Docker Compose para API, banco, LocalStack e workers independentes.
- `prom-client` para métricas Prometheus e logs JSON do NestJS.

> **Escopo:** ambiente de demonstração/avaliação, não configuração pronta para produção. Credenciais locais `backend`/`test` não devem ser utilizadas em produção. As APIs de negócio não estão protegidas por um provedor de identidade neste escopo; veja [ARCHITECTURE.md](./ARCHITECTURE.md#autenticação-e-fronteira-de-confiança).

## Componentes

| Serviço | Papel |
| --- | --- |
| `backend-api` | API HTTP para carteiras, apostas, ledger, consultas e reconciliação |
| `backend-consumer` | Recebe `WagerTransactionRequested` da fila SQS e executa o mesmo caso de uso da API |
| `backend-outbox` | Publica eventos confirmados do PostgreSQL na fila de eventos |
| `backend-pending-reference` | Reavalia REFUND/ROLLBACK em `PENDING_REFERENCE` |
| `backend-migrate` | Aplica migrations antes de subir a API |
| `backend-queues` | Garante a existência/configuração das filas SQS no LocalStack |
| `postgres` / `localstack` | Persistência e mensageria |

### Garantias principais

- Montantes entram e saem da API como **strings decimais** (`"25.00"`), nunca `number` para dinheiro.
- Uma carteira não pode ficar com saldo negativo; SQL e domínio impõem a regra.
- O ledger é append-only: UPDATE, DELETE e TRUNCATE são bloqueados por triggers.
- `wallets.balance` é saldo materializado; pode ser reconstruído e confrontado com o ledger.
- A idempotência não depende de cache nem apenas da deduplicação de FIFO.
- Alteração de carteira, transação, ledger, Inbox (no SQS) e Outbox são confirmados atomicamente no PostgreSQL.
- O SQS oferece entrega **at-least-once**: redelivery e publicação duplicada são possibilidades previstas no desenho.

## Pré-requisitos

- Docker Desktop + Docker Compose.
- Bun **1.x** instalado localmente para desenvolvimento e execução de testes (a imagem da entrega utiliza Bun 1.4.3).
- PowerShell no Windows ou shell equivalente.
- Portas `3000` (API), `5432` (PostgreSQL) e `4566` (LocalStack) livres, caso estejam expostas pelo Compose base.

O projeto possui um Compose base com serviços `postgres` e `localstack`, complementado pelo arquivo `compose.delivery.yaml`.

## Configuração

Crie/atualize o `.env` na raiz. Valores de exemplo **somente para desenvolvimento local**:

```dotenv
DATABASE_URL=postgresql://backend:backend@127.0.0.1:5432/backend_challenge
SQS_ENDPOINT=http://localhost:4566
SQS_REGION=us-east-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
SQS_EVENTS_QUEUE_URL=http://localhost:4566/queue/us-east-1/000000000000/wager-events.fifo
SQS_WAGER_QUEUE_URL=http://localhost:4566/queue/us-east-1/000000000000/wager-transactions.fifo
SQS_WAGER_DLQ_URL=http://localhost:4566/queue/us-east-1/000000000000/wager-transactions-dlq.fifo
SQS_WAGER_VISIBILITY_SECONDS=120
SQS_WAGER_WAIT_SECONDS=10
```

> Dentro do Docker, **não** use `localhost` para conectar outros containers. `compose.delivery.yaml` sobrescreve as variáveis com os hosts de serviço `postgres:5432` e `localstack:4566`, e a estratégia de URL de fila por caminho (`SQS_ENDPOINT_STRATEGY=path`). Os valores finais devem corresponder às URLs devolvidas pelo LocalStack. Não versione o `.env`.

Se o Compose base utilizar nomes/credenciais distintos, alinhe `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` e o `DATABASE_URL` antes de executar.

## Iniciar tudo com Docker Compose (recomendado)

No PowerShell, na raiz do projeto:

```powershell
$baseCompose = @('compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml') |
  Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $baseCompose) { throw 'Arquivo Compose base não encontrado.' }

docker compose -f $baseCompose -f compose.delivery.yaml config --quiet
docker compose -f $baseCompose -f compose.delivery.yaml up -d --build
docker compose -f $baseCompose -f compose.delivery.yaml ps
```

A API fica em `http://127.0.0.1:3000` se a porta 3000 estiver publicada no host. Os serviços `backend-migrate` e `backend-queues` são tarefas de inicialização e devem terminar com saída `0`.

Verificação de saúde:

```powershell
Invoke-RestMethod 'http://127.0.0.1:3000/health/live'
Invoke-RestMethod 'http://127.0.0.1:3000/health/ready' | ConvertTo-Json -Depth 5
```

Para logs e escalabilidade:

```powershell
docker compose -f $baseCompose -f compose.delivery.yaml logs --tail 80 backend-api backend-outbox backend-consumer backend-pending-reference
docker compose -f $baseCompose -f compose.delivery.yaml up -d --scale backend-consumer=3
```

Para encerrar **sem remover volumes**:

```powershell
docker compose -f $baseCompose -f compose.delivery.yaml down
```

**Não execute `docker compose down -v`** a menos que queira apagar os volumes do ambiente de teste.

## Desenvolvimento fora dos containers

```powershell
bun install
docker compose up -d postgres localstack
$env:MIKRO_ORM_ALLOW_GLOBAL_CLI = 'true'
bunx mikro-orm migration:up --config ./src/mikro-orm.config.ts
bun scripts/setup-sqs.ts
bun scripts/setup-wager-queues.ts
```

Inicie os processos em terminais separados:

```powershell
bun src/main.ts
bun scripts/run-wager-consumer.ts
bun scripts/run-outbox-publisher.ts
bun scripts/run-pending-reference-worker.ts
```

Se os nomes dos scripts de bootstrap locais diferirem, o caminho recomendado é o Compose completo, que utiliza `scripts/bootstrap-delivery-queues.ts`.

## API HTTP

| Método | Rota | Resultado |
| --- | --- | --- |
| `POST` | `/wallets` | Abre carteira; saldo inicial positivo gera `OPENING` e ledger |
| `GET` | `/wallets/:walletId` | Saldo, moeda e versão |
| `GET` | `/wallets/:walletId/ledger?limit=50&cursor=...` | Ledger ordenado, paginação por cursor |
| `POST` | `/wagering/transactions` | BET/WIN/LOSS/REFUND/ROLLBACK; header `Idempotency-Key` obrigatório |
| `GET` | `/wagering/transactions/:transactionId` | Consulta por UUID interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pela identidade do provedor |
| `POST` | `/wallets/:walletId/reconciliation` | Compara saldo armazenado e calculado a partir do ledger |
| `GET` | `/health/live` | Liveness, não verifica dependências |
| `GET` | `/health/ready` | PostgreSQL + filas SQS |
| `GET` | `/metrics` | Métricas no formato Prometheus |

### Criar carteira (PowerShell)

```powershell
$baseUrl = 'http://127.0.0.1:3000'
$playerId = [guid]::NewGuid().ToString()

$wallet = Invoke-RestMethod -Uri "$baseUrl/wallets" -Method Post `
  -ContentType 'application/json' `
  -Body (@{
    playerId = $playerId
    initialBalance = @{ amount = '100.00'; currency = 'BRL' }
  } | ConvertTo-Json -Depth 5)

$walletId = $wallet.id
$wallet | ConvertTo-Json -Depth 5
```

### Submeter uma BET (PowerShell)

```powershell
$providerId = 'provider-demo'
$externalId = [guid]::NewGuid().ToString()
$key = "${providerId}:${externalId}"

$bet = Invoke-RestMethod -Uri "$baseUrl/wagering/transactions" -Method Post `
  -Headers @{ 'Idempotency-Key' = $key } `
  -ContentType 'application/json' `
  -Body (@{
    providerId = $providerId
    externalTransactionId = $externalId
    playerId = $playerId
    walletId = $walletId
    roundId = 'round-001'
    gameId = 'game-demo'
    kind = 'BET'
    money = @{ amount = '25.00'; currency = 'BRL' }
  } | ConvertTo-Json -Depth 5)

$bet | ConvertTo-Json -Depth 5
```

Resultado esperado para a primeira BET: `status: PROCESSED`, saldo `75.00 BRL`, `idempotentReplay: false`. Repetir a mesma requisição/chave não causa segundo débito e retorna replay. **A mesma chave com payload financeiro diferente deve ser conflito**, nunca um segundo processamento.

### Consultar ledger e reconciliar

```powershell
Invoke-RestMethod "$baseUrl/wallets/$walletId/ledger?limit=50" | ConvertTo-Json -Depth 7
Invoke-RestMethod -Uri "$baseUrl/wallets/$walletId/reconciliation" -Method Post | ConvertTo-Json -Depth 5
```

Status HTTP de referência: `200` para processada/replay e consultas, `202` para `PENDING_REFERENCE`, `422` para rejeição financeira, `400` para payload inválido, `404` para recurso inexistente; conflitos de idempotência são distintos das rejeições de negócio. `POST /wallets` retorna `201` quando cria uma carteira.

## SQS e eventos

Filas FIFO:

- `wager-transactions.fifo`: comandos de apostas; `MessageGroupId = walletId`.
- `wager-transactions-dlq.fifo`: mensagens inválidas ou não processáveis após o limite de entregas; `maxReceiveCount = 5` na configuração de demonstração.
- `wager-events.fifo`: eventos confirmados da Outbox.

Envelope de entrada:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-10-23T00:00:00.000Z",
  "data": {
    "providerId": "provider-demo",
    "externalTransactionId": "bet-123",
    "idempotencyKey": "provider-demo:bet-123",
    "playerId": "UUID-DO-JOGADOR",
    "walletId": "UUID-DA-WALLET",
    "roundId": "round-001",
    "gameId": "game-demo",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

O Consumer confirma `DeleteMessage` apenas após o caso de uso retornar com o commit do banco. `REJECTED` e `PENDING_REFERENCE` persistidos são resultados de negócio confirmados, portanto podem receber ACK. Erros transitórios permitem redelivery. O broker não é fonte de verdade da idempotência.

Eventos de integração: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference` e `WalletBalanceChanged` (este apenas quando o saldo muda).

## Testes

**Preparação:** PostgreSQL e LocalStack precisam estar disponíveis. Suítes de integração criam recursos temporários ou exigem bancos de testes dedicados. **Não use o banco de desenvolvimento** nas suítes destrutivas ou que injetam falhas.

```powershell
bunx tsc --noEmit
bun test src/domain
bun test src/application
```

### Integração SQS e reconciliação

```powershell
$env:DATABASE_URL = 'postgresql://backend:backend@127.0.0.1:5432/backend_challenge_test'
bun test tests/integration/sqs-consumer.integration.test.ts
bun test tests/integration/reconciliation.integration.test.ts
```

### Concorrência HTTP (3 instâncias reais)

```powershell
$env:DATABASE_URL = 'postgresql://backend:backend@127.0.0.1:5432/backend_challenge_test'
.\scripts\run-concurrency-tests.ps1
```

Verifica 50 BETs idênticas, duas BETs de `80.00` disputando `100.00` e wallets independentes em paralelo.

### Workers, falhas e recuperação

```powershell
$env:DATABASE_URL = 'postgresql://backend:backend@127.0.0.1:5432/backend_challenge_workers_test'
bun test tests/integration/parallel-outbox.integration.test.ts
bun test tests/integration/sqs-workers-recovery.integration.test.ts
bun test tests/integration/pending-reference-recovery.integration.test.ts
bun test tests/integration/financial-atomicity.integration.test.ts
```

As suítes são executadas **individualmente** para evitar disputa por recursos temporários. Elas cobrem dois publishers, três consumidores, crash entre commit/ACK, reentrega, referências fora de ordem, rollback de falha no ledger/Outbox e rejeição após o limite de retries.

### Auditoria das migrations (banco criado automaticamente)

```powershell
$env:DATABASE_URL = 'postgresql://backend:backend@127.0.0.1:5432/backend_challenge'
.\scripts\run-schema-audit.ps1
```

O script cria um banco descartável, executa `migration:up`, sete testes de constraints, `migration:down --to 0`, novo `migration:up` e os sete testes novamente. **Resultado validado durante o desenvolvimento: 14 verificações aprovadas.** Não execute `migration:down` no banco principal.

## Observabilidade

- `GET /health/live`: verifica o processo.
- `GET /health/ready`: verifica PostgreSQL, fila de entrada, fila de eventos e DLQ; responde `503` se alguma estiver indisponível.
- `GET /metrics`: métricas de operações por status, replays, retries, conflitos de versão, latência, reconciliação, atraso na Outbox e quantidade aproximada na DLQ.
- Logs JSON incluem IDs de correlação/transação/wallet/provedor nos pontos instrumentados, sem payload financeiro completo.

As métricas de contadores são locais a cada processo. O `/metrics` da API não agrega automaticamente contadores dos workers externos. Consulte as limitações em [ARCHITECTURE.md](./ARCHITECTURE.md).

## Solução de problemas

| Sintoma | Verificação |
| --- | --- |
| `Cannot GET /health/live` | `HealthModule` importado em `AppModule`; API atual na porta 3000 |
| `/health/ready` retorna `503` | PostgreSQL, LocalStack, filas e URLs configuradas |
| `The specified queue does not exist` | Filas criadas, região, conta, `SQS_*_QUEUE_URL` e hostname correto |
| `INTEGRATION_TEST_REQUIRES_TEST_DATABASE` | Ajustar `DATABASE_URL` **somente no terminal de testes** |
| `migration:down` falha | Revisar `down()` da migration indicada; auditar exclusivamente em banco descartável |
| Eventos pendentes na Outbox | Publisher ativo, SQS alcançável, política de retry e logs |
| REFUND em `PENDING_REFERENCE` | `pending_reference_attempts`, `next_reference_attempt_at`, worker de referência |

## Documentação complementar

Consulte [ARCHITECTURE.md](./ARCHITECTURE.md) para invariantes de domínio, estratégia de locks e idempotência, diagramas de fluxo, tratamento de falhas, decisões de autenticação e trade-offs.
