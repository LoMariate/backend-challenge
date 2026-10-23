# Backend Challenge - Etapa 19.4: revisao final

Este checklist nao altera o banco de dados principal. Execute comandos de integracao apenas em bancos dedicados.

## 1. Preparar o checkout

No PowerShell, na raiz do projeto:

```powershell
# Se .env nao existir, copie o modelo local (ajuste credenciais/URLs conforme seu Compose)
if (-not (Test-Path .env)) { Copy-Item .env.example .env }

bun install --frozen-lockfile
```

Certifique-se de que o `.gitignore` exclui `.env`, `node_modules/`, `.test-logs/`, `dist/` e `coverage/`, mas NAO exclui `.env.example` nem `bun.lock`.

## 2. Preflight nao destrutivo

```powershell
.\scripts\final-preflight.ps1
```

O script verifica arquivos esperados, arquivos `.env` rastreados, whitespace do Git, TypeScript, testes unitarios e configuracao combinada do Compose. Se sua API estiver executando, execute tambem:

```powershell
.\scripts\final-preflight.ps1 -CheckRunningApi
```

AVISO: preflight nao substitui testes de integracao. Ele nao executa migration:down, nao cria banco nem exclui volumes.

## 3. Subir a stack e testar a API

```powershell
$baseCompose = @('compose.yaml','compose.yml','docker-compose.yml','docker-compose.yaml') |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $baseCompose) { throw 'Compose base nao encontrado.' }

docker compose -f $baseCompose -f compose.delivery.yaml config --quiet
docker compose -f $baseCompose -f compose.delivery.yaml up -d --build
docker compose -f $baseCompose -f compose.delivery.yaml ps

Invoke-RestMethod 'http://127.0.0.1:3000/health/live'
Invoke-RestMethod 'http://127.0.0.1:3000/health/ready' | ConvertTo-Json -Depth 5
.\scripts\test-reconciliation.ps1
```

Os endpoints health devem retornar status `ok` (ready depende do banco e das filas). Nao use `docker compose down -v` em um ambiente com dados a preservar.

## 4. Testes de integracao, sempre isolados

```powershell
# PostgreSQL e LocalStack locais precisam estar ativos.
$env:DATABASE_URL = 'postgresql://backend:backend@127.0.0.1:5432/backend_challenge_test'
bun test tests/integration/sqs-consumer.integration.test.ts
bun test tests/integration/reconciliation.integration.test.ts
.\scripts\run-concurrency-tests.ps1

$env:DATABASE_URL = 'postgresql://backend:backend@127.0.0.1:5432/backend_challenge_workers_test'
bun test tests/integration/parallel-outbox.integration.test.ts
bun test tests/integration/sqs-workers-recovery.integration.test.ts
bun test tests/integration/pending-reference-recovery.integration.test.ts
bun test tests/integration/financial-atomicity.integration.test.ts

Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
```

Seus bancos precisam ter migrations aplicadas. Ajuste credenciais conforme seu ambiente. NAO execute as suites juntas em paralelo nem use o banco de desenvolvimento com testes que injetam falhas.

## 5. Auditoria reversivel do schema (banco novo e descartavel)

```powershell
$env:DATABASE_URL = 'postgresql://backend:backend@127.0.0.1:5432/backend_challenge'
.\scripts\run-schema-audit.ps1
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
```

Resultado ja obtido no desenvolvimento: 7 testes na primeira aplicacao e 7 depois de `migration:down --to 0` + `migration:up` = 14 verificacoes. Nunca faca `migration:down` no banco principal.

## 6. Revisao de entrega

Confira se README e ARCHITECTURE possuem comandos exatos, mapeamento HTTP, idempotencia, locks, reentrega, retry, observabilidade, limitacoes e decisao de autenticacao. Endpoints financeiros NAO devem ser expostos publicamente sem identidade/autorizacao.

```powershell
git status --short
git diff --check
git diff --cached --check
git ls-files -- .env .env.local .env.production
```

Nao versionar `.env`, credenciais reais, `.test-logs`, `node_modules` ou bancos locais. Versionar `bun.lock`, migrations (incluindo correcao de down da Migration20261022150202), fontes, scripts e docs.

Revisar a lista antes de criar o commit:

```powershell
git add README.md ARCHITECTURE.md .env.example .gitignore .dockerignore `
  Dockerfile.delivery compose.delivery.yaml src scripts tests package.json bun.lock

git diff --cached --stat
git diff --cached --check
git status --short
# Somente apos a revisao visual do staged diff:
git commit -m 'Finalize distributed wallet backend challenge'
```

Caso `src`, `scripts` ou `tests` contenham arquivos locais nao destinados a entrega, use `git add -p` em vez do bloco acima. `git add` nao faz upload; o push para repositório remoto é uma acao separada. Confirme o branch e o remoto antes do `git push`.
