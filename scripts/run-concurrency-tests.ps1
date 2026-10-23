$ErrorActionPreference = "Stop"

# ==================================================
# CONFIGURACAO
# ==================================================

$ports = @(3101, 3102, 3103)

$projectRoot = (
    Resolve-Path (Join-Path $PSScriptRoot "..")
).Path

$logsDir = Join-Path $projectRoot ".test-logs"

$processes = @()

$originalPort = $env:PORT

# ==================================================
# SEGURANCA: BANCO DE TESTES OBRIGATORIO
# ==================================================

if ([string]::IsNullOrWhiteSpace($env:DATABASE_URL)) {
    throw "Defina DATABASE_URL para backend_challenge_test."
}

$databaseName = (
    [uri]$env:DATABASE_URL
).AbsolutePath

if ($databaseName -ne "/backend_challenge_test") {
    throw "O teste exige o banco backend_challenge_test."
}

# Encontrar o executavel do Bun.
$bunExecutable = (
    Get-Command bun -CommandType Application -ErrorAction Stop
).Source

New-Item `
    -ItemType Directory `
    -Path $logsDir `
    -Force | Out-Null

Write-Host "Banco: backend_challenge_test"
Write-Host "Logs: $logsDir"

# ==================================================
# INICIAR 3 PROCESSOS INDEPENDENTES
# ==================================================

try {
    # Verificar se as portas estao livres.
    foreach ($port in $ports) {
        $listener = Get-NetTCPConnection `
            -LocalPort $port `
            -State Listen `
            -ErrorAction SilentlyContinue

        if ($listener) {
            throw "A porta $port ja esta ocupada."
        }
    }

    foreach ($port in $ports) {
        # Cada processo herda PORT e DATABASE_URL
        # definidos neste terminal.
        $env:PORT = "$port"

        $stdout = Join-Path $logsDir "api-$port.log"
        $stderr = Join-Path $logsDir "api-$port-error.log"

        Write-Host "Iniciando API na porta $port..."

        $process = Start-Process `
            -FilePath $bunExecutable `
            -ArgumentList "src/main.ts" `
            -WorkingDirectory $projectRoot `
            -RedirectStandardOutput $stdout `
            -RedirectStandardError $stderr `
            -PassThru

        $processes += $process
    }

    # ==================================================
    # AGUARDAR READINESS DAS TRES INSTANCIAS
    # ==================================================

    foreach ($port in $ports) {
        $ready = $false

        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            try {
                $response = Invoke-WebRequest `
                    -Uri "http://127.0.0.1:$port/health/ready" `
                    -UseBasicParsing `
                    -TimeoutSec 3 `
                    -ErrorAction Stop

                if ([int]$response.StatusCode -eq 200) {
                    $ready = $true
                    break
                }
            }
            catch {
                # A aplicacao pode ainda estar iniciando.
            }

            Start-Sleep -Milliseconds 500
        }

        if (-not $ready) {
            throw "API da porta $port nao ficou READY. Confira $logsDir."
        }

        Write-Host "PASSOU: API $port esta READY."
    }

    Write-Host ""
    Write-Host "Executando testes distribuidos..."
    Write-Host ""

    # ==================================================
    # EXECUTAR O BUN TEST
    # ==================================================

    Push-Location $projectRoot

    try {
        & $bunExecutable test `
            tests/concurrency/http-concurrency.test.ts

        $testExitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }

    if ($testExitCode -ne 0) {
        throw "Os testes de concorrencia falharam."
    }

    Write-Host ""
    Write-Host "TODOS OS TESTES DISTRIBUIDOS PASSARAM"
}
finally {
    # ==================================================
    # ENCERRAR SOMENTE OS PROCESSOS CRIADOS PELO TESTE
    # ==================================================

    Write-Host ""
    Write-Host "Encerrando instancias de teste..."

    foreach ($process in $processes) {
        if (-not $process.HasExited) {
            Stop-Process `
                -Id $process.Id `
                -Force `
                -ErrorAction SilentlyContinue
        }
    }

    # Restaurar PORT anterior.
    if ([string]::IsNullOrEmpty($originalPort)) {
        Remove-Item Env:PORT -ErrorAction SilentlyContinue
    }
    else {
        $env:PORT = $originalPort
    }

    Write-Host "Instancias de teste encerradas."
}
