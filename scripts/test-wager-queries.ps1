$ErrorActionPreference = "Stop"

$baseUrl = "http://127.0.0.1:3000"

function Assert-Equal {
    param(
        [string]$Name,
        [string]$Expected,
        [string]$Actual
    )

    if ($Expected -ne $Actual) {
        throw "FALHOU: $Name. Esperado=$Expected Recebido=$Actual"
    }

    Write-Host "PASSOU: $Name"
}

function Assert-HttpStatus {
    param(
        [string]$Name,
        [string]$Url,
        [int]$ExpectedStatus
    )

    try {
        Invoke-RestMethod `
            -Uri $Url `
            -Method Get `
            -ErrorAction Stop | Out-Null

        throw "ERRO: A consulta deveria retornar HTTP $ExpectedStatus"
    }
    catch {
        if ($null -eq $_.Exception.Response) {
            throw
        }

        $received = [int]$_.Exception.Response.StatusCode

        if ($received -ne $ExpectedStatus) {
            throw "FALHOU: $Name. Esperado=$ExpectedStatus Recebido=$received"
        }

        Write-Host "PASSOU: $Name - HTTP $received"
    }
}

# ==========================================
# 1. CRIAR UMA WALLET COM R$ 100,00
# ==========================================

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
    -Body $walletBody `
    -ErrorAction Stop

$walletId = $wallet.id

Write-Host "Wallet criada: $walletId"

# ==========================================
# 2. PROCESSAR UMA BET DE R$ 30,00
# ==========================================

$providerId = "provider-query-test"

$externalId = [guid]::NewGuid().ToString()

$betBody = @{
    providerId = $providerId
    externalTransactionId = $externalId
    playerId = $playerId
    walletId = $walletId
    roundId = "round-query"
    gameId = "game-query"
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
        "Idempotency-Key" = "${providerId}:$externalId"
    } `
    -ContentType "application/json" `
    -Body $betBody `
    -ErrorAction Stop

$transactionId = $bet.transactionId

Assert-Equal "BET processada" "PROCESSED" $bet.status
Assert-Equal "Saldo depois da BET" "70.00" $bet.balance.amount

# ==========================================
# 3. GET PELO ID INTERNO
# ==========================================

$byId = Invoke-RestMethod `
    -Uri "$baseUrl/wagering/transactions/$transactionId" `
    -Method Get `
    -ErrorAction Stop

Assert-Equal "GET por ID: transactionId" `
    $transactionId $byId.transactionId

Assert-Equal "GET por ID: kind" `
    "BET" $byId.kind

Assert-Equal "GET por ID: status" `
    "PROCESSED" $byId.status

Assert-Equal "GET por ID: valor" `
    "30.00" $byId.money.amount

Assert-Equal "GET por ID: saldo observado" `
    "70.00" $byId.observedBalance.amount

# ==========================================
# 4. GET PELO PROVEDOR
# ==========================================

$encodedProvider = [uri]::EscapeDataString($providerId)
$encodedExternal = [uri]::EscapeDataString($externalId)

$byProvider = Invoke-RestMethod `
    -Uri "$baseUrl/providers/$encodedProvider/wagering/transactions/$encodedExternal" `
    -Method Get `
    -ErrorAction Stop

Assert-Equal "GET por provedor: transactionId" `
    $transactionId $byProvider.transactionId

Assert-Equal "GET por provedor: externalTransactionId" `
    $externalId $byProvider.externalTransactionId

Assert-Equal "GET por provedor: status" `
    "PROCESSED" $byProvider.status

Assert-Equal "GET por provedor: saldo observado" `
    "70.00" $byProvider.observedBalance.amount

# ==========================================
# 5. TRATAMENTO DE ERROS
# ==========================================

Assert-HttpStatus `
    -Name "UUID invalido" `
    -Url "$baseUrl/wagering/transactions/uuid-invalido" `
    -ExpectedStatus 400

$missingId = "11111111-1111-4111-8111-111111111111"

Assert-HttpStatus `
    -Name "Transacao interna inexistente" `
    -Url "$baseUrl/wagering/transactions/$missingId" `
    -ExpectedStatus 404

Assert-HttpStatus `
    -Name "Transacao externa inexistente" `
    -Url "$baseUrl/providers/$encodedProvider/wagering/transactions/nao-existe" `
    -ExpectedStatus 404

# ==========================================
# RESULTADO FINAL
# ==========================================

Write-Host ""
Write-Host "========================================"
Write-Host "TODOS OS TESTES DE CONSULTA PASSARAM"
Write-Host "========================================"
Write-Host "Wallet: $walletId"
Write-Host "Transaction: $transactionId"
