$ErrorActionPreference = 'Stop'

# Cria um banco temporario EXCLUSIVO, aplica todas as migrations,
# valida as constraints, executa DOWN ate 0 e depois UP novamente.
# NUNCA executa DOWN no banco principal.

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$originalUrl = $env:DATABASE_URL
$originalGlobalCli = $env:MIKRO_ORM_ALLOW_GLOBAL_CLI

if ([string]::IsNullOrWhiteSpace($originalUrl)) {
    throw 'Defina DATABASE_URL para sua conexao LOCAL antes de rodar a auditoria.'
}

$original = [Uri]$originalUrl
if ($original.Host -notin @('localhost', '127.0.0.1')) {
    throw 'A auditoria aceita apenas PostgreSQL local acessivel pelo Windows.'
}
if ($original.Scheme -notin @('postgres', 'postgresql')) {
    throw 'DATABASE_URL deve usar postgresql:// ou postgres://.'
}

$database = 'backend_challenge_schema_audit_' + ([guid]::NewGuid().ToString('N').Substring(0, 12))
$pgUser = [uri]::UnescapeDataString(($original.UserInfo -split ':')[0])
if ([string]::IsNullOrWhiteSpace($pgUser)) {
    throw 'Usuario do PostgreSQL nao encontrado em DATABASE_URL.'
}

$builder = [UriBuilder]::new($originalUrl)
$builder.Path = "/$database"
$testUrl = $builder.Uri.AbsoluteUri

$created = $false
$success = $false

function Assert-ExitCode {
    param([string]$Description)
    if ($LASTEXITCODE -ne 0) {
        throw "$Description falhou (exit code $LASTEXITCODE)."
    }
}

Push-Location $projectRoot
try {
    Write-Host "Criando banco descartavel: $database"
    & docker compose exec -T postgres psql `
      -v 'ON_ERROR_STOP=1' -U $pgUser -d postgres `
      -c "CREATE DATABASE $database;"
    Assert-ExitCode 'CREATE DATABASE'
    $created = $true

    $env:DATABASE_URL = $testUrl
    $env:MIKRO_ORM_ALLOW_GLOBAL_CLI = 'true'

    Write-Host '1/5 - migration:up (banco vazio)'
    & bunx mikro-orm migration:up --config ./src/mikro-orm.config.ts
    Assert-ExitCode 'migration:up inicial'

    Write-Host '2/5 - Testes de constraints do schema'
    & bun test tests/integration/schema-constraints.integration.test.ts
    Assert-ExitCode 'Teste inicial de constraints'

    Write-Host '3/5 - migration:down --to 0 (SOMENTE no banco descartavel)'
    & bunx mikro-orm migration:down --to 0 --config ./src/mikro-orm.config.ts
    Assert-ExitCode 'migration:down'

    Write-Host '4/5 - migration:up (recriando o schema)'
    & bunx mikro-orm migration:up --config ./src/mikro-orm.config.ts
    Assert-ExitCode 'migration:up apos rollback'

    Write-Host '5/5 - Reexecutar a auditoria no schema reconstruido'
    & bun test tests/integration/schema-constraints.integration.test.ts
    Assert-ExitCode 'Auditoria final'

    $success = $true
    Write-Host ''
    Write-Host 'PASSOU: constraints e migrations reversiveis/reaplicaveis.'
}
finally {
    if ($null -eq $originalUrl) {
        Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
    } else {
        $env:DATABASE_URL = $originalUrl
    }

    if ($null -eq $originalGlobalCli) {
        Remove-Item Env:MIKRO_ORM_ALLOW_GLOBAL_CLI -ErrorAction SilentlyContinue
    } else {
        $env:MIKRO_ORM_ALLOW_GLOBAL_CLI = $originalGlobalCli
    }

    if ($created) {
        if ($success) {
            Write-Host "Removendo banco descartavel validado: $database"
            & docker compose exec -T postgres psql `
              -v 'ON_ERROR_STOP=1' -U $pgUser -d postgres `
              -c "DROP DATABASE $database WITH (FORCE);"
            if ($LASTEXITCODE -ne 0) {
                Write-Warning "Nao foi possivel remover $database automaticamente."
            }
        } else {
            Write-Warning "Auditoria interrompida. Banco temporario PRESERVADO para diagnostico: $database"
        }
    }
    Pop-Location
}
