# Aceite da R1a: percorre convite -> cadastro -> login -> canais -> token LiveKit contra o backend REAL
# (imagem de produção, em contêiner) e valida os tokens no LiveKit REAL pelo endpoint /rtc/validate.
#
# Não mexe no seu ambiente de desenvolvimento: usa contêineres e volume descartáveis com nomes próprios
# e portas só em 127.0.0.1 (LiveKit em 17880, backend em 18080). Tudo é removido no final.
#
# Uso: powershell -ExecutionPolicy Bypass -File scripts\e2e.ps1
. "$PSScriptRoot\_docker.ps1"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Net.Http

$lkPort = 17880
$apiPort = 18080
$api = "http://127.0.0.1:$apiPort"
$lk = "http://127.0.0.1:$lkPort"

$suffix = -join ((97..122) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$lkName = "livekit-e2e-lk-$suffix"
$apiName = "livekit-e2e-api-$suffix"
$volume = "livekit-e2e-data-$suffix"
$image = 'livekit-backend:e2e'

# Segredos aleatórios só desta execução (32+ caracteres, como o backend exige).
function New-Secret { -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 40 | ForEach-Object { [char]$_ }) }
$jwtSecret = New-Secret
$lkSecret = New-Secret
$lkKey = 'e2ekey'
$adminPassword = 'admin-' + (New-Secret).Substring(0, 12)
$userPassword = 'user-' + (New-Secret).Substring(0, 12)

$script:passed = 0
$script:failed = 0
function Check {
    param([string]$Name, [bool]$Condition, [string]$Detail = '')
    if ($Condition) { $script:passed++; Write-Host "  PASSOU  $Name" -ForegroundColor Green }
    else { $script:failed++; Write-Host "  FALHOU  $Name $Detail" -ForegroundColor Red }
}

# HttpClient em vez de Invoke-RestMethod: o Windows PowerShell 5.1 lança exceção em qualquer 4xx/5xx,
# e aqui os códigos de erro são justamente o que queremos conferir.
$http = New-Object System.Net.Http.HttpClient
$http.Timeout = [TimeSpan]::FromSeconds(15)
function Invoke-Api {
    param([string]$Method, [string]$Url, $Body = $null, [string]$Token = '')
    $request = New-Object System.Net.Http.HttpRequestMessage ([System.Net.Http.HttpMethod]::new($Method), $Url)
    if ($null -ne $Body) {
        $request.Content = New-Object System.Net.Http.StringContent (($Body | ConvertTo-Json -Compress), [System.Text.Encoding]::UTF8, 'application/json')
    }
    if ($Token) { $request.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue ('Bearer', $Token) }
    $response = $http.SendAsync($request).GetAwaiter().GetResult()
    $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    $json = $null
    if ($text) { try { $json = $text | ConvertFrom-Json } catch { $json = $null } }
    [pscustomobject]@{ Status = [int]$response.StatusCode; Body = $json; Raw = $text }
}

# Decodifica o payload de um JWT (base64url) para conferir as permissões emitidas.
function Read-JwtPayload {
    param([string]$Jwt)
    $part = $Jwt.Split('.')[1].Replace('-', '+').Replace('_', '/')
    $part = $part.PadRight($part.Length + (4 - $part.Length % 4) % 4, '=')
    [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($part)) | ConvertFrom-Json
}

function Remove-E2eResources {
    docker rm -f $apiName $lkName *> $null
    docker volume rm -f $volume *> $null
}

$exitCode = 1
try {
    Assert-Docker

    $compose = Get-Content (Join-Path $script:RepoRoot 'infra\docker-compose.yml') -Raw
    if ($compose -notmatch 'image:\s*(livekit/livekit-server:\S+)') { throw 'Imagem do LiveKit não encontrada em infra/docker-compose.yml' }
    $lkImage = $Matches[1]

    Write-Host "`n=== Preparação ===" -ForegroundColor Cyan
    Write-Host "Construindo a imagem do backend ($image)..."
    docker build -q -t $image (Join-Path $script:RepoRoot 'backend') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'docker build falhou' }

    Write-Host "Subindo LiveKit ($lkImage) em $lk ..."
    docker run -d --name $lkName -p "127.0.0.1:${lkPort}:7880" `
        -e "LIVEKIT_KEYS=${lkKey}: $lkSecret" `
        -v "$($script:RepoRoot)\infra\livekit.yaml:/etc/livekit.yaml:ro" `
        $lkImage --config /etc/livekit.yaml | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'não foi possível subir o LiveKit (porta 17880 ocupada?)' }

    Write-Host "Subindo o backend em $api ..."
    docker volume create $volume | Out-Null
    docker run -d --name $apiName -p "127.0.0.1:${apiPort}:8080" -v "${volume}:/data" `
        -e "JWT_SECRET=$jwtSecret" -e "LIVEKIT_API_KEY=$lkKey" -e "LIVEKIT_API_SECRET=$lkSecret" `
        -e "LIVEKIT_PUBLIC_URL=ws://localhost:$lkPort" `
        -e 'SEED_ADMIN_USERNAME=admin' -e "SEED_ADMIN_PASSWORD=$adminPassword" `
        $image | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'não foi possível subir o backend (porta 18080 ocupada?)' }

    $ready = $false
    for ($i = 0; $i -lt 40 -and -not $ready; $i++) {
        try { $ready = (Invoke-Api GET "$api/health").Status -eq 200 } catch { $ready = $false }
        if (-not $ready) { Start-Sleep -Milliseconds 500 }
    }
    if (-not $ready) { throw 'o backend não respondeu em /health' }
    $ready = $false
    for ($i = 0; $i -lt 40 -and -not $ready; $i++) {
        try { $ready = (Invoke-WebRequest "$lk/" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { $ready = $false }
        if (-not $ready) { Start-Sleep -Milliseconds 500 }
    }
    if (-not $ready) { throw 'o LiveKit não respondeu' }

    Write-Host "`n=== Fluxo de identidade ===" -ForegroundColor Cyan
    $r = Invoke-Api GET "$api/health"
    Check 'GET /health' ($r.Status -eq 200 -and $r.Body.status -eq 'ok')

    $seedOut = (docker exec $apiName /server seed) -join "`n"
    Check 'server seed (7 canais + admin)' ($LASTEXITCODE -eq 0 -and $seedOut -match 'Canais garantidos: 7') $seedOut

    $inviteOut = (docker exec $apiName /server invite create --hours 1) -join "`n"
    $code = ($inviteOut -split "`n")[0] -replace '^.*:\s*', ''
    Check 'server invite create' ($LASTEXITCODE -eq 0 -and $code.Length -ge 8) $inviteOut

    $r = Invoke-Api POST "$api/api/auth/register" @{ inviteCode = $code; username = 'amiga'; password = $userPassword }
    Check 'POST /api/auth/register com convite válido -> 201' ($r.Status -eq 201 -and $r.Body.token -and $r.Body.user.username -eq 'amiga' -and -not $r.Body.user.isAdmin) $r.Raw
    $registeredId = $r.Body.user.id

    $r = Invoke-Api POST "$api/api/auth/register" @{ inviteCode = $code; username = 'outra'; password = $userPassword }
    Check 'convite reutilizado -> 400' ($r.Status -eq 400) $r.Raw

    $r = Invoke-Api POST "$api/api/auth/login" @{ username = 'amiga'; password = $userPassword }
    Check 'POST /api/auth/login -> 200' ($r.Status -eq 200 -and $r.Body.token) $r.Raw
    $session = $r.Body.token

    $r = Invoke-Api POST "$api/api/auth/login" @{ username = 'amiga'; password = 'senha-errada-123' }
    Check 'login com senha errada -> 401' ($r.Status -eq 401) $r.Raw

    $r = Invoke-Api POST "$api/api/auth/login" @{ username = 'admin'; password = $adminPassword }
    Check 'login do admin criado pelo seed -> 200 e isAdmin' ($r.Status -eq 200 -and $r.Body.user.isAdmin) $r.Raw

    $r = Invoke-Api GET "$api/api/channels"
    Check 'GET /api/channels sem token -> 401' ($r.Status -eq 401) $r.Raw

    $r = Invoke-Api GET "$api/api/channels" -Token $session
    $channels = @($r.Body.channels)
    Check 'GET /api/channels com token -> 7 canais em ordem' ($r.Status -eq 200 -and $channels.Count -eq 7 -and $channels[0].name -eq 'Voz 1' -and $channels[6].name -eq 'Voz 7') $r.Raw
    $channelId = $channels[0].id

    Write-Host "`n=== Tokens LiveKit validados pelo LiveKit ===" -ForegroundColor Cyan
    $r = Invoke-Api POST "$api/api/livekit/token" @{ channelId = 'canal-que-nao-existe'; role = 'voice' } -Token $session
    Check 'token para canal inexistente -> 404' ($r.Status -eq 404) $r.Raw

    foreach ($role in @('voice', 'spectator')) {
        $r = Invoke-Api POST "$api/api/livekit/token" @{ channelId = $channelId; role = $role } -Token $session
        Check "POST /api/livekit/token ($role) -> 200" ($r.Status -eq 200 -and $r.Body.token -and $r.Body.url -eq "ws://localhost:$lkPort" -and $r.Body.roomName -eq "channel-$channelId") $r.Raw
        if ($r.Status -ne 200) { continue }
        $token = $r.Body.token

        $payload = Read-JwtPayload $token
        if ($role -eq 'voice') {
            Check 'voice: identidade = id do usuário, publica e não é oculto' ($payload.sub -eq $registeredId -and $payload.video.canPublish -eq $true -and -not $payload.video.hidden)
        } else {
            Check 'spectator: identidade com #spectator, oculto e sem publicar' ($payload.sub -eq "$registeredId#spectator" -and $payload.video.hidden -eq $true -and $payload.video.canPublish -eq $false -and $payload.video.canPublishData -eq $false)
        }

        $v = Invoke-WebRequest "$lk/rtc/validate?access_token=$token" -UseBasicParsing -TimeoutSec 10
        Check "LiveKit aceita o token ($role) em /rtc/validate" ($v.StatusCode -eq 200) "status $($v.StatusCode)"
    }

    # Controle negativo: sem ele, um /rtc/validate que aceita qualquer coisa faria o teste passar à toa.
    $forged = $token.Substring(0, $token.Length - 4) + 'AAAA'
    try {
        $v = Invoke-WebRequest "$lk/rtc/validate?access_token=$forged" -UseBasicParsing -TimeoutSec 10
        Check 'LiveKit recusa token adulterado' ($v.StatusCode -ge 400) "status $($v.StatusCode)"
    } catch {
        $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        Check 'LiveKit recusa token adulterado' ($status -ge 400) $_.Exception.Message
    }
} catch {
    $script:failed++
    Write-Host "  ERRO    $($_.Exception.Message)" -ForegroundColor Red
} finally {
    if ($script:failed -gt 0) {
        Write-Host "`n--- logs do backend ---" -ForegroundColor Yellow
        docker logs --tail 40 $apiName 2>&1 | Out-Host
        Write-Host "`n--- logs do LiveKit ---" -ForegroundColor Yellow
        docker logs --tail 20 $lkName 2>&1 | Out-Host
    }
    Remove-E2eResources
    $http.Dispose()
}

Write-Host "`n=== Resultado do aceite ===" -ForegroundColor Cyan
Write-Host ("  {0} passaram, {1} falharam" -f $script:passed, $script:failed)
if ($script:failed -eq 0 -and $script:passed -gt 0) { $exitCode = 0 }
exit $exitCode
