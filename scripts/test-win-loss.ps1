$baseUrl = "http://127.0.0.1:3000"

# Criar uma wallet com R$ 100,00.
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

# Operacoes a serem executadas.
$operations = @(
    @{
        Kind = "BET"
        Amount = "30.00"
        Expected = "70.00"
    },
    @{
        Kind = "WIN"
        Amount = "50.00"
        Expected = "120.00"
    },
    @{
        Kind = "LOSS"
        Amount = "30.00"
        Expected = "120.00"
    }
)

$requests = @()

foreach ($operation in $operations) {

    $externalId = [guid]::NewGuid().ToString()
    $key = "provider-a:$externalId"

    $body = @{
        providerId = "provider-a"
        externalTransactionId = $externalId
        playerId = $playerId
        walletId = $walletId
        roundId = "round-test-win-loss"
        gameId = "game-test"
        kind = $operation.Kind
        money = @{
            amount = $operation.Amount
            currency = "BRL"
        }
    } | ConvertTo-Json -Depth 5

    $response = Invoke-RestMethod `
        -Uri "$baseUrl/wagering/transactions" `
        -Method Post `
        -Headers @{ "Idempotency-Key" = $key } `
        -ContentType "application/json" `
        -Body $body `
        -ErrorAction Stop

    Write-Host "$($operation.Kind): saldo $($response.balance.amount)"

    if (
        $response.status -ne "PROCESSED" -or
        $response.balance.amount -ne $operation.Expected -or
        $response.idempotentReplay -ne $false
    ) {
        throw "TEST_FAILED:$($operation.Kind)"
    }

    $requests += [pscustomobject]@{
        Kind = $operation.Kind
        Body = $body
        Key = $key
        TransactionId = $response.transactionId
        Expected = $operation.Expected
    }
}

Write-Host "BET, WIN e LOSS passaram."

# Repetir todas as operacoes.
foreach ($request in $requests) {

    $replay = Invoke-RestMethod `
        -Uri "$baseUrl/wagering/transactions" `
        -Method Post `
        -Headers @{ "Idempotency-Key" = $request.Key } `
        -ContentType "application/json" `
        -Body $request.Body `
        -ErrorAction Stop

    if (
        $replay.idempotentReplay -ne $true -or
        $replay.transactionId -ne $request.TransactionId -or
        $replay.balance.amount -ne $request.Expected
    ) {
        throw "REPLAY_FAILED:$($request.Kind)"
    }

    Write-Host "Replay $($request.Kind): OK"
}

Write-Host "Todos os testes passaram."
Write-Host "Wallet para consultar no banco: $walletId"
