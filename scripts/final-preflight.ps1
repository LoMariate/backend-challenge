param(
    [switch]$CheckRunningApi,
    [switch]$SkipUnitTests
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Get-Location).Path
$errors = New-Object 'System.Collections.Generic.List[string]'
$warnings = New-Object 'System.Collections.Generic.List[string]'

function Pass([string]$message) { Write-Host "PASSOU: $message" -ForegroundColor Green }
function Fail([string]$message) {
    $script:errors.Add($message)
    Write-Host "FALHOU: $message" -ForegroundColor Red
}
function Warn([string]$message) {
    $script:warnings.Add($message)
    Write-Host "AVISO: $message" -ForegroundColor Yellow
}
function Run-Checked([string]$label, [scriptblock]$command) {
    Write-Host "`n== $label ==" -ForegroundColor Cyan
    try {
        & $command
        if ($LASTEXITCODE -ne 0) {
            Fail "$label (exit code $LASTEXITCODE)"
        } else {
            Pass $label
        }
    } catch {
        Fail "$label - $($_.Exception.Message)"
    }
}

Write-Host "Auditoria final nao destrutiva: $projectRoot" -ForegroundColor Cyan

$required = @(
    'README.md',
    'ARCHITECTURE.md',
    'package.json',
    'tsconfig.json',
    'bun.lock',
    'Dockerfile.delivery',
    'compose.delivery.yaml',
    'src/main.ts',
    'src/mikro-orm.config.ts',
    'scripts/run-wager-consumer.ts',
    'scripts/run-outbox-publisher.ts',
    'scripts/run-pending-reference-worker.ts',
    'scripts/bootstrap-delivery-queues.ts',
    'scripts/run-schema-audit.ps1',
    'tests/integration/schema-constraints.integration.test.ts',
    'tests/integration/financial-atomicity.integration.test.ts',
    'src/application/ports/provider-identity.port.ts'
)

foreach ($path in $required) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Fail "Arquivo obrigatorio para esta entrega nao encontrado: $path"
    }
}
if ($errors.Count -eq 0) { Pass 'Arquivos esperados presentes' }

$baseCompose = @('compose.yaml','compose.yml','docker-compose.yml','docker-compose.yaml') |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1
if (-not $baseCompose) { Fail 'Compose base (postgres/localstack) nao encontrado' }
else { Pass "Compose base: $baseCompose" }

$gitExists = $null -ne (Get-Command git -ErrorAction SilentlyContinue)
$bunExists = $null -ne (Get-Command bun -ErrorAction SilentlyContinue)
$dockerExists = $null -ne (Get-Command docker -ErrorAction SilentlyContinue)
if (-not $gitExists) { Fail 'Git nao encontrado no PATH' }
if (-not $bunExists) { Fail 'Bun nao encontrado no PATH' }
if (-not $dockerExists) { Fail 'Docker nao encontrado no PATH' }

if (-not (Test-Path '.gitignore' -PathType Leaf)) {
    Warn '.gitignore ausente'
}
if (-not (Test-Path '.dockerignore' -PathType Leaf)) {
    Warn '.dockerignore ausente'
}
if (-not (Test-Path '.env.example' -PathType Leaf)) {
    Warn 'Considere criar .env.example sem segredos para o avaliador'
}

if ($gitExists) {
    & git rev-parse --is-inside-work-tree 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Warn 'Pasta ainda nao e um repositorio Git; nao foi possivel verificar arquivos versionados'
    } else {
        $trackedSensitive = @(& git ls-files -- '.env' '.env.local' '.env.production' '.env.test' '.env.*.local')
        if ($trackedSensitive.Count -gt 0) {
            Fail "Arquivos de ambiente versionados: $($trackedSensitive -join ', ')"
        } else { Pass 'Nenhum .env conhecido versionado' }

        Run-Checked 'git diff --check' { & git diff --check }
        Run-Checked 'git diff --cached --check' { & git diff --cached --check }
        Write-Host "`n== Arquivos modificados ou nao rastreados ==" -ForegroundColor Cyan
        & git status --short
    }
}

if ($bunExists) {
    Run-Checked 'TypeScript strict check: bunx tsc --noEmit' { & bunx tsc --noEmit }
    if (-not $SkipUnitTests) {
        Run-Checked 'Testes unitarios: dominio e aplicacao' { & bun test src/domain src/application }
    } else { Warn 'Testes unitarios ignorados via -SkipUnitTests' }
}

if ($dockerExists -and $baseCompose) {
    Run-Checked 'docker compose config --quiet' {
        & docker compose -f $baseCompose -f 'compose.delivery.yaml' config --quiet
    }
}

if ($CheckRunningApi) {
    Write-Host "`n== Smoke HTTP na API ja iniciada ==" -ForegroundColor Cyan
    foreach ($route in @('/health/live', '/health/ready')) {
        try {
            $result = Invoke-RestMethod -Uri "http://127.0.0.1:3000$route" -Method Get -TimeoutSec 10
            if ($result.status -eq 'ok') { Pass "$route -> ok" }
            else { Fail "$route retornou status '$($result.status)'" }
        } catch { Fail "$route - $($_.Exception.Message)" }
    }
} else { Warn 'Smoke HTTP ignorado; opcional: .\\scripts\\final-preflight.ps1 -CheckRunningApi' }

Write-Host "`n=================================" -ForegroundColor Cyan
Write-Host "FALHAS: $($errors.Count) | AVISOS: $($warnings.Count)" -ForegroundColor Cyan
if ($errors.Count -eq 0) {
    Pass 'Preflight basico aprovado (integracoes e auditoria devem ser executadas separadamente)'
    exit 0
}
Write-Host 'Corrija as falhas antes de preparar o commit.' -ForegroundColor Red
exit 1
