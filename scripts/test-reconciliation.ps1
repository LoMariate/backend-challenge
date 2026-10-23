$ErrorActionPreference = "Stop"

$baseUrl = "http://127.0.0.1:3000"

# Criar um jogador.
$playerId = [guid]::NewGuid().ToString()

# Criar carteira com 100.00 BRL.
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
    -Body $walletBody `
    -ErrorAction Stop

$walletId = $wallet.id

Write-Host "Wallet criada: $walletId"

# BET de 30.00.
$externalId = [guid]::NewGuid().ToString()

$betBody = @{
    providerId = "provider-reconciliation-test"
    externalTransactionId = $externalId
    playerId = $playerId
    walletId = $walletId
    roundId = "round-reconciliation"
    gameId = "game-reconciliation"
    kind = "BET"
    money = @{
        amount = "30.00"
        currency = "BRL"
    }
} | ConvertTo-Json -Depth 5

$bet = Invoke-RestMethod `
    -Uri "$baseUrl/wagering/transactions" `
    -Method Post `
    -Headers @{
        "Idempotency-Key" = "provider-reconciliation-test:$externalId"
    } `
    -ContentType "application/json" `
    -Body $betBody `
    -ErrorAction Stop

if ($bet.status -ne "PROCESSED") {
    throw "BET_NOT_PROCESSED"
}

Write-Host "BET processada."

# Reconciliar.
$reconciliation = Invoke-RestMethod `
    -Uri "$baseUrl/wallets/$walletId/reconciliation" `
    -Method Post `
    -ErrorAction Stop

Write-Host "Resultado da reconciliacao:"
$reconciliation | ConvertTo-Json -Depth 5

if (-not $reconciliation.consistent) {
    throw "RECONCILIATION_DIVERGENCE"
}

if ($reconciliation.storedBalance.amount -ne "70.00") {
    throw "INVALID_STORED_BALANCE"
}

if ($reconciliation.calculatedBalance.amount -ne "70.00") {
    throw "INVALID_CALCULATED_BALANCE"
}

if ($reconciliation.difference.amount -ne "0.00") {
    throw "INVALID_DIFFERENCE"
}

if ($reconciliation.checkedEntries -ne 2) {
    throw "INVALID_LEDGER_ENTRY_COUNT"
}

# Garantir que consultar não alterou a wallet.
$currentWallet = Invoke-RestMethod `
    -Uri "$baseUrl/wallets/$walletId" `
    -Method Get `
    -ErrorAction Stop

if ($currentWallet.balance.amount -ne "70.00") {
    throw "WALLET_CHANGED_BY_RECONCILIATION"
}

if ($currentWallet.version -ne 2) {
    throw "WALLET_VERSION_CHANGED"
}

Write-Host ""
Write-Host "PASSOU: saldo armazenado = 70.00"
Write-Host "PASSOU: saldo calculado = 70.00"
Write-Host "PASSOU: diferenca = 0.00"
Write-Host "PASSOU: 2 entradas verificadas"
Write-Host "PASSOU: wallet e versao preservadas"
Write-Host "RECONCILIACAO CONCLUIDA COM SUCESSO"
