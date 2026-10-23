$ErrorActionPreference = "Stop"

$baseUrl = "http://127.0.0.1:3000"

# 1. Criar uma wallet com 100.00 BRL.
$playerId = [guid]::NewGuid().ToString()

$walletBody = @{
    playerId = $playerId
    initialBalance = @{
        amount = "100.00"
        currency = "BRL"
    }
} | ConvertTo-Json -Depth 5

$wallet = Invoke-RestMethod `
    -Uri "$baseUrl/wallets" `
    -Method Post `
    -ContentType "application/json" `
    -Body $walletBody

$walletId = $wallet.id

Write-Host "Wallet criada: $walletId"

# 2. Gerar uma BET e uma WIN.
$operations = @(
    @{ Kind = "BET"; Amount = "30.00" },
    @{ Kind = "WIN"; Amount = "20.00" }
)

foreach ($operation in $operations) {

    $externalId = [guid]::NewGuid().ToString()

    $body = @{
        providerId = "provider-ledger-test"
        externalTransactionId = $externalId
        playerId = $playerId
        walletId = $walletId
        roundId = "round-ledger-test"
        gameId = "game-ledger-test"
        kind = $operation.Kind
        money = @{
            amount = $operation.Amount
            currency = "BRL"
        }
    } | ConvertTo-Json -Depth 5

    $result = Invoke-RestMethod `
        -Uri "$baseUrl/wagering/transactions" `
        -Method Post `
        -Headers @{
            "Idempotency-Key" = "provider-ledger-test:$externalId"
        } `
        -ContentType "application/json" `
        -Body $body

    if ($result.status -ne "PROCESSED") {
        throw "TRANSACTION_NOT_PROCESSED"
    }

    Write-Host "$($operation.Kind) processada."
}

# Existem 3 entradas:
# OPENING, BET e WIN.

# 3. Buscar a primeira pagina.
$page1 = Invoke-RestMethod `
    -Uri "$baseUrl/wallets/$walletId/ledger?limit=2" `
    -Method Get

Write-Host "Pagina 1:"
$page1 | ConvertTo-Json -Depth 6

if ($page1.items.Count -ne 2) {
    throw "PAGE_1_WRONG_SIZE"
}

if (-not $page1.pageInfo.hasMore) {
    throw "PAGE_1_SHOULD_HAVE_MORE"
}

if (-not $page1.pageInfo.nextCursor) {
    throw "PAGE_1_MISSING_CURSOR"
}

# 4. Buscar a segunda pagina.
$cursor = [uri]::EscapeDataString(
    $page1.pageInfo.nextCursor
)

$page2 = Invoke-RestMethod `
    -Uri "$baseUrl/wallets/$walletId/ledger?limit=2&cursor=$cursor" `
    -Method Get

Write-Host "Pagina 2:"
$page2 | ConvertTo-Json -Depth 6

if ($page2.items.Count -ne 1) {
    throw "PAGE_2_WRONG_SIZE"
}

if ($page2.pageInfo.hasMore) {
    throw "PAGE_2_SHOULD_BE_LAST"
}

if ($null -ne $page2.pageInfo.nextCursor) {
    throw "PAGE_2_SHOULD_NOT_HAVE_CURSOR"
}

# 5. Garantir que nao existem IDs duplicados.
$allIds = @()

foreach ($entry in $page1.items) {
    $allIds += $entry.id
}

foreach ($entry in $page2.items) {
    $allIds += $entry.id
}

$uniqueIds = @($allIds | Select-Object -Unique)

if ($allIds.Count -ne 3) {
    throw "WRONG_TOTAL_ENTRIES"
}

if ($uniqueIds.Count -ne 3) {
    throw "DUPLICATED_LEDGER_ENTRY"
}

Write-Host "PASSOU: pagina 1 possui 2 entradas"
Write-Host "PASSOU: pagina 2 possui 1 entrada"
Write-Host "PASSOU: nenhuma entrada duplicada"
Write-Host "PASSOU: fim da paginacao identificado"
Write-Host "TODOS OS TESTES DE PAGINACAO PASSARAM"
