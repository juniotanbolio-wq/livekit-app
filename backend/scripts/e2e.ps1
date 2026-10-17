#Requires -Version 7.0
# Aceite das fases R1a e R1b contra o backend REAL (imagem de produção, em contêiner) e o LiveKit REAL.
#
# R1a: convite -> cadastro -> login -> canais -> token LiveKit, com os tokens validados pelo LiveKit (/rtc/validate).
# R1b: tempo real. Participantes de verdade (um "bot" com a server-sdk-go, que entra nas salas com tokens emitidos
#      pelo backend e publica uma trilha de tela) disparam webhooks REAIS do LiveKit, e o que chega pelo WebSocket
#      é conferido: presença, início e fim de transmissão, menções, limites, reconciliação e encerramento.
#
# Não mexe no seu ambiente de desenvolvimento: usa contêineres, rede e volume descartáveis com nomes próprios e
# portas só em 127.0.0.1 (LiveKit em 17880, backend em 18080). Tudo é removido no final.
#
# Uso: pwsh -NoProfile -File scripts\e2e.ps1
. "$PSScriptRoot\_docker.ps1"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Net.Http

$lkPort = 17880
$apiPort = 18080
$api = "http://127.0.0.1:$apiPort"
$lk = "http://127.0.0.1:$lkPort"
$wsUrl = "ws://127.0.0.1:$apiPort/ws"

$suffix = -join ((97..122) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$lkName = "livekit-e2e-lk-$suffix"
$apiName = "livekit-e2e-api-$suffix"
$netName = "livekit-e2e-net-$suffix"
$volume = "livekit-e2e-data-$suffix"
$image = 'livekit-backend:e2e'
$tempRoot = [System.IO.Path]::GetTempPath()
$botDir = Join-Path $tempRoot "livekit-e2e-bot-$suffix"
$lkConfig = Join-Path $tempRoot "livekit-e2e-$suffix.yaml"

# Segredos só desta execução, do gerador criptográfico do .NET (Get-Random não é: é previsível, e o
# `-Count` ainda sorteava sem repetição). 48 caracteres hex = 192 bits, acima dos 32 que o backend exige.
function New-Secret {
    $secret = [System.Security.Cryptography.RandomNumberGenerator]::GetHexString(48, $true)
    if ($secret.Length -ne 48 -or $secret -match '^(.)\1+$') { throw 'gerador de segredos devolveu valor inválido' }
    $secret
}
$jwtSecret = New-Secret
$lkSecret = New-Secret
$lkKey = 'e2ekey'
$adminPassword = 'admin-' + (New-Secret).Substring(0, 12)
$userPassword = 'user-' + (New-Secret).Substring(0, 12)

$script:passed = 0
$script:failed = 0
$script:bots = New-Object System.Collections.ArrayList
$script:sockets = New-Object System.Collections.ArrayList
function Check {
    param([string]$Name, [bool]$Condition, [string]$Detail = '')
    if ($Condition) { $script:passed++; Write-Host "  PASSOU  $Name" -ForegroundColor Green }
    else { $script:failed++; Write-Host "  FALHOU  $Name $Detail" -ForegroundColor Red }
}

# HttpClient em vez de Invoke-RestMethod: o cmdlet lança exceção em qualquer 4xx/5xx (sem
# -SkipHttpErrorCheck), e aqui os códigos de erro são justamente o que queremos conferir.
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

# --- Webhook assinado (o mesmo formato que o LiveKit envia) ---
function ConvertTo-Base64Url {
    param([byte[]]$Bytes)
    [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

# JWT HS256 com o SHA-256 do corpo, como o LiveKit assina cada webhook.
function New-WebhookJwt {
    param([string]$Key, [string]$Secret, [string]$Body)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $hash = [Convert]::ToBase64String($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Body)))
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $header = ConvertTo-Base64Url ([System.Text.Encoding]::UTF8.GetBytes('{"alg":"HS256","typ":"JWT"}'))
    $claims = ConvertTo-Json -Compress @{ iss = $Key; nbf = $now - 10; exp = $now + 300; sha256 = $hash }
    $payload = ConvertTo-Base64Url ([System.Text.Encoding]::UTF8.GetBytes($claims))
    $hmac = New-Object System.Security.Cryptography.HMACSHA256 (, [System.Text.Encoding]::UTF8.GetBytes($Secret))
    $signature = ConvertTo-Base64Url ($hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes("$header.$payload")))
    "$header.$payload.$signature"
}

function Invoke-Webhook {
    param([string]$Body, [string]$Authorization = '')
    $request = New-Object System.Net.Http.HttpRequestMessage ([System.Net.Http.HttpMethod]::Post, "$api/webhooks/livekit")
    $request.Content = New-Object System.Net.Http.StringContent ($Body, [System.Text.Encoding]::UTF8, 'application/webhook+json')
    if ($Authorization) { [void]$request.Headers.TryAddWithoutValidation('Authorization', $Authorization) }
    [int]($http.SendAsync($request).GetAwaiter().GetResult().StatusCode)
}

# --- Cliente WebSocket de teste (System.Net.WebSockets.ClientWebSocket do .NET) ---
# Uma ReceiveAsync fica "pendente" entre leituras: esperar com timeout NÃO pode cancelar a leitura, porque
# cancelar um ReceiveAsync aborta o socket inteiro.
function New-Ws {
    param([string]$Label, [string]$Query = '', [string]$Origin = '')
    $socket = New-Object System.Net.WebSockets.ClientWebSocket
    if ($Origin) { $socket.Options.SetRequestHeader('Origin', $Origin) }
    $ws = [pscustomobject]@{
        Label = $Label; Socket = $socket; Pending = $null; Buffer = $null
        Log = (New-Object System.Collections.ArrayList); Closed = $false; CloseStatus = 0; Snapshot = $null
    }
    [void]$script:sockets.Add($ws)
    $connected = $socket.ConnectAsync([Uri]"$wsUrl$Query", [System.Threading.CancellationToken]::None).Wait(8000)
    if (-not $connected -or $socket.State -ne [System.Net.WebSockets.WebSocketState]::Open) {
        throw "WebSocket '$Label' não abriu (concluiu=$connected, estado=$($socket.State))"
    }
    $ws
}

function Send-Ws {
    param($Ws, $Object)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($Object | ConvertTo-Json -Compress))
    $Ws.Socket.SendAsync([ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).Wait(5000) | Out-Null
}

# Devolve a próxima mensagem (já convertida de JSON) ou $null se estourar o tempo ou a conexão fechar.
function Receive-Ws {
    param($Ws, [int]$TimeoutMs = 8000)
    if ($Ws.Closed) { return $null }
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    $text = ''
    while ($true) {
        if ($null -eq $Ws.Pending) {
            $Ws.Buffer = New-Object byte[] 32768
            $Ws.Pending = $Ws.Socket.ReceiveAsync([ArraySegment[byte]]::new($Ws.Buffer), [System.Threading.CancellationToken]::None)
        }
        $remaining = [Math]::Max(0, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds)
        try { $done = $Ws.Pending.Wait($remaining) }
        catch { $Ws.Pending = $null; $Ws.Closed = $true; $Ws.CloseStatus = -1; return $null }
        if (-not $done) { return $null }
        $result = $Ws.Pending.Result
        $Ws.Pending = $null
        if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
            $Ws.Closed = $true
            $Ws.CloseStatus = [int]$result.CloseStatus
            return $null
        }
        $text += [System.Text.Encoding]::UTF8.GetString($Ws.Buffer, 0, $result.Count)
        if ($result.EndOfMessage) { break }
    }
    $message = $text | ConvertFrom-Json
    [void]$Ws.Log.Add($message)
    $message
}

# Lê até achar uma mensagem que satisfaça $Match (as outras ficam no Log, em ordem). $null se não achar a tempo.
function Wait-WsMessage {
    param($Ws, [scriptblock]$Match, [int]$TimeoutSec = 20)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
    while ([DateTime]::UtcNow -lt $deadline -and -not $Ws.Closed) {
        $left = [Math]::Max(100, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds)
        $message = Receive-Ws $Ws $left
        if ($null -ne $message -and (& $Match $message)) { return $message }
    }
    $null
}

# Lê tudo que chegar durante $Seconds e devolve as mensagens (para provar que NADA chegou).
function Read-WsFor {
    param($Ws, [int]$Seconds)
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    $got = @()
    while ([DateTime]::UtcNow -lt $deadline -and -not $Ws.Closed) {
        $message = Receive-Ws $Ws 500
        if ($null -ne $message) { $got += $message }
    }
    , $got
}

# Espera a pessoa aparecer transmitindo, de qualquer das duas formas válidas do protocolo: um participant_joined
# que já traz isScreenSharing=true (ela publicou a tela antes de o backend saber que ela entrou, como acontece
# quando a reconciliação a descobre) ou um stream_started depois do participant_joined.
function Wait-UserSharing {
    param($Ws, [string]$ChannelId, [string]$UserId, [int]$TimeoutSec = 60)
    $match = {
        param($m)
        $m.channelId -eq $ChannelId -and (
            ($m.type -eq 'participant_joined' -and $m.participant.userId -eq $UserId -and $m.participant.isScreenSharing -eq $true) -or
            ($m.type -eq 'stream_started' -and $m.userId -eq $UserId))
    }
    $null -ne (Wait-WsMessage $Ws $match $TimeoutSec)
}

function Wait-WsClosed {
    param($Ws, [int]$TimeoutSec = 10)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
    while (-not $Ws.Closed -and [DateTime]::UtcNow -lt $deadline) { [void](Receive-Ws $Ws 500) }
    $Ws.Closed
}

# Conecta, autentica pela primeira mensagem (o token NUNCA vai na URL) e guarda o snapshot inicial.
function Connect-Ws {
    param([string]$Label, [string]$Token)
    $ws = New-Ws $Label
    Send-Ws $ws @{ type = 'auth'; token = $Token }
    $ws.Snapshot = Wait-WsMessage $ws { param($m) $m.type -eq 'snapshot' } 10
    $ws
}

function Close-Ws {
    param($Ws)
    try { $Ws.Socket.Abort(); $Ws.Socket.Dispose() } catch { Write-Verbose "socket já fechado: $($_.Exception.Message)" }
}

# Participantes de um canal no snapshot.
function Get-SnapshotChannel {
    param($Snapshot, [string]$ChannelId)
    # A vírgula impede o PowerShell de "desembrulhar" um array de um elemento (e perder o .Count).
    , @($Snapshot.channels | Where-Object { $_.channelId -eq $ChannelId } | ForEach-Object { $_.participants })
}

# A sequência é o contrato do protocolo: depois do snapshot, cada evento tem seq = anterior + 1, sem buracos.
function Test-SeqContiguous {
    param($Ws)
    $expected = $null
    foreach ($m in $Ws.Log) {
        if ($m.type -eq 'snapshot') { $expected = [long]$m.seq + 1; continue }
        if ($null -eq $m.seq) { continue }
        if ($null -eq $expected) { return $false }
        if ([long]$m.seq -ne $expected) { return $false }
        $expected++
    }
    $true
}

# --- Bots (participantes reais do LiveKit) ---
function Start-Bot {
    param([string]$Name, [string]$Token, [string[]]$BotArgs = @())
    $container = "livekit-e2e-bot-$Name-$suffix"
    [void]$script:bots.Add($container)
    docker run -d --name $container --network $netName -v "${botDir}:/bot:ro" $script:GoImage /bot/e2ebot --url "ws://${lkName}:7880" --token $Token @BotArgs | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "não foi possível iniciar o bot $Name" }
    $container
}

# docker stop envia SIGTERM: o bot faz Disconnect (leave) e o LiveKit dispara participant_left na hora.
function Stop-Bot {
    param([string]$Container)
    docker stop -t 15 $Container | Out-Null
}

function Get-LiveKitToken {
    param([string]$Session, [string]$ChannelId, [string]$Role)
    $r = Invoke-Api POST "$api/api/livekit/token" @{ channelId = $ChannelId; role = $Role } -Token $Session
    if ($r.Status -ne 200) { throw "token LiveKit ($Role) falhou: $($r.Raw)" }
    $r.Body.token
}

function New-TestUser {
    param([string]$Name)
    $out = (docker exec $apiName /server invite create --hours 1) -join "`n"
    $code = ($out -split "`n")[0] -replace '^.*:\s*', ''
    $r = Invoke-Api POST "$api/api/auth/register" @{ inviteCode = $code; username = $Name; password = $userPassword }
    if ($r.Status -ne 201) { throw "cadastro de $Name falhou: $($r.Raw)" }
    [pscustomobject]@{ Name = $Name; Id = $r.Body.user.id; Session = $r.Body.token }
}

# Logs de um contêiner (stdout + stderr) como texto. O 'Continue' local garante que linhas de stderr do
# docker (onde ficam os logs do backend) nunca virem exceção com $ErrorActionPreference = 'Stop'.
function Get-ContainerLog {
    param([string]$Name, [int]$Tail = 0)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $dockerArgs = @('logs')
        if ($Tail -gt 0) { $dockerArgs += @('--tail', $Tail) }
        @(& docker @dockerArgs $Name 2>&1 | ForEach-Object { "$_" })
    } finally { $ErrorActionPreference = $previous }
}

function Get-BackendLog { Get-ContainerLog $apiName }

function Wait-BackendReady {
    $ready = $false
    for ($i = 0; $i -lt 40 -and -not $ready; $i++) {
        try { $ready = (Invoke-Api GET "$api/health").Status -eq 200 } catch { $ready = $false }
        if (-not $ready) { Start-Sleep -Milliseconds 500 }
    }
    $ready
}

function Remove-E2eResources {
    foreach ($ws in $script:sockets) { Close-Ws $ws }
    foreach ($bot in $script:bots) { docker rm -f $bot *> $null }
    docker rm -f $apiName $lkName *> $null
    docker network rm $netName *> $null
    docker volume rm -f $volume *> $null
    Remove-Item -Recurse -Force $botDir, $lkConfig -ErrorAction SilentlyContinue
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

    Write-Host 'Compilando o bot de teste (cmd/e2ebot)...'
    New-Item -ItemType Directory -Path $botDir | Out-Null
    $code = Invoke-Go -GoArgs @('build', '-o', '/out/e2ebot', './cmd/e2ebot') -ExtraArgs @('-v', "${botDir}:/out", '-e', 'CGO_ENABLED=0')
    if ($code -ne 0) { throw 'build do bot falhou' }

    docker network create $netName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'não foi possível criar a rede Docker do teste' }

    # O livekit.yaml do repositório aponta o webhook para o serviço "backend" do Compose, com a chave devkey.
    # Aqui o backend e a chave têm outros nomes, então o teste usa uma cópia ajustada (o arquivo real não muda).
    $yaml = (Get-Content (Join-Path $script:RepoRoot 'infra\livekit.yaml') -Raw).Replace('api_key: devkey', "api_key: $lkKey").Replace('http://backend:8080/webhooks/livekit', "http://${apiName}:8080/webhooks/livekit")
    if ($yaml -notmatch "api_key: $lkKey" -or $yaml -notmatch [regex]::Escape("http://${apiName}:8080/webhooks/livekit")) { throw 'infra/livekit.yaml mudou: ajuste a substituição do webhook no e2e.ps1' }
    [System.IO.File]::WriteAllText($lkConfig, $yaml, (New-Object System.Text.UTF8Encoding $false))

    Write-Host "Subindo LiveKit ($lkImage) em $lk ..."
    docker run -d --name $lkName --network $netName -p "127.0.0.1:${lkPort}:7880" `
        -e "LIVEKIT_KEYS=${lkKey}: $lkSecret" `
        -v "${lkConfig}:/etc/livekit.yaml:ro" `
        $lkImage --config /etc/livekit.yaml | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'não foi possível subir o LiveKit (porta 17880 ocupada?)' }

    Write-Host "Subindo o backend em $api ..."
    docker volume create $volume | Out-Null
    # Criado na rede padrão (porta publicada no host) e ligado também à rede do teste (para falar com o LiveKit).
    # Assim, desconectar da rede do teste corta LiveKit<->backend sem derrubar o acesso do teste ao backend.
    # Limites ajustados para o teste conseguir exercitá-los com poucas mensagens.
    docker create --name $apiName -p "127.0.0.1:${apiPort}:8080" -v "${volume}:/data" `
        -e "JWT_SECRET=$jwtSecret" -e "LIVEKIT_API_KEY=$lkKey" -e "LIVEKIT_API_SECRET=$lkSecret" `
        -e "LIVEKIT_PUBLIC_URL=ws://localhost:$lkPort" -e "LIVEKIT_URL=http://${lkName}:7880" `
        -e 'SEED_ADMIN_USERNAME=admin' -e "SEED_ADMIN_PASSWORD=$adminPassword" `
        -e 'AUTH_RATE_LIMIT=50' -e 'RECONCILE_INTERVAL=5s' -e 'WS_AUTH_TIMEOUT=2s' -e 'WS_MAX_CONNS_PER_USER=3' `
        -e 'MENTION_SENDER_LIMIT=4' -e 'MENTION_RECIPIENT_LIMIT=3' -e 'MENTION_WINDOW=10m' `
        $image | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'não foi possível criar o backend (porta 18080 ocupada?)' }
    docker network connect $netName $apiName | Out-Null
    docker start $apiName | Out-Null

    if (-not (Wait-BackendReady)) { throw 'o backend não respondeu em /health' }
    $ready = $false
    for ($i = 0; $i -lt 40 -and -not $ready; $i++) {
        try { $ready = (Invoke-WebRequest "$lk/" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { $ready = $false }
        if (-not $ready) { Start-Sleep -Milliseconds 500 }
    }
    if (-not $ready) { throw 'o LiveKit não respondeu' }

    Write-Host "`n=== Fluxo de identidade ===" -ForegroundColor Cyan
    $r = Invoke-Api GET "$api/health"
    Check 'GET /health (com livekitUrl público)' ($r.Status -eq 200 -and $r.Body.status -eq 'ok' -and $r.Body.livekitUrl -eq "ws://localhost:$lkPort") $r.Raw

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

    # =====================================================================================================
    # R1b: tempo real
    # =====================================================================================================
    $chan1 = $channels[0].id
    $chan2 = $channels[1].id
    $alice = [pscustomobject]@{ Name = 'amiga'; Id = $registeredId; Session = $session }
    $bruno = New-TestUser 'bruno'
    $carla = New-TestUser 'carla'
    $dora = New-TestUser 'dora'

    Write-Host "`n=== Webhook: assinatura do LiveKit ===" -ForegroundColor Cyan
    # Evento de uma sala que não é de canal: se a assinatura for aceita, vira 200 e não muda a presença.
    $harmless = '{"event":"participant_joined","room":{"name":"sala-qualquer"},"participant":{"sid":"PA_x","identity":"x"},"id":"e2e","createdAt":1}'
    Check 'webhook sem assinatura -> 401' ((Invoke-Webhook $harmless) -eq 401)
    Check 'webhook com Authorization inválido -> 401' ((Invoke-Webhook $harmless 'isto-nao-e-um-jwt') -eq 401)
    Check 'webhook assinado com segredo errado -> 401' ((Invoke-Webhook $harmless (New-WebhookJwt $lkKey (New-Secret) $harmless)) -eq 401)
    Check 'webhook com corpo adulterado -> 401' ((Invoke-Webhook ($harmless + ' ') (New-WebhookJwt $lkKey $lkSecret $harmless)) -eq 401)
    Check 'webhook com assinatura válida -> 200' ((Invoke-Webhook $harmless (New-WebhookJwt $lkKey $lkSecret $harmless)) -eq 200)
    $r = Invoke-Api GET "$api/webhooks/livekit"
    Check 'GET no webhook -> 405' ($r.Status -eq 405)

    Write-Host "`n=== WebSocket: autenticação ===" -ForegroundColor Cyan
    $mute = New-Ws 'mudo'
    Check 'conexão que não se autentica no prazo é fechada' (Wait-WsClosed $mute 8)

    $badAuth = New-Ws 'token-ruim'
    Send-Ws $badAuth @{ type = 'auth'; token = 'lixo' }
    $err = Wait-WsMessage $badAuth { param($m) $m.type -eq 'error' } 5
    [void](Wait-WsClosed $badAuth 5)
    Check 'token inválido -> erro unauthorized e fechamento 1008' ($err.code -eq 'unauthorized' -and $badAuth.CloseStatus -eq 1008)

    $inUrl = New-Ws 'token-na-url' -Query "?token=$($alice.Session)"
    Check 'token na URL não autentica (só a primeira mensagem vale)' ((Wait-WsClosed $inUrl 8) -and $null -eq $inUrl.Snapshot)

    try { [void](New-Ws 'origem-ruim' -Origin 'http://evil.example'); $evil = 'aceita' } catch { $evil = $_.Exception.ToString() }
    Check 'origem de navegador fora da lista -> recusada (403)' ($evil -match '403') $evil

    Write-Host "`n=== WebSocket: snapshot inicial ===" -ForegroundColor Cyan
    $brunoWs = Connect-Ws 'bruno' $bruno.Session
    $doraWs = Connect-Ws 'dora' $dora.Session
    $snap = $brunoWs.Snapshot
    Check 'snapshot: 7 canais, todos vazios, com seq' ($null -ne $snap -and @($snap.channels).Count -eq 7 -and @($snap.channels | Where-Object { @($_.participants).Count -gt 0 }).Count -eq 0 -and $null -ne $snap.seq) ($snap | ConvertTo-Json -Compress -Depth 5)

    Write-Host "`n=== Presença e transmissão com um participante real ===" -ForegroundColor Cyan
    $aliceVoice = Get-LiveKitToken $alice.Session $chan1 'voice'
    $botA = Start-Bot 'alice' $aliceVoice @('--publish-screen-after', '3s', '--unpublish-screen-after', '10s')

    $joined = Wait-WsMessage $brunoWs { param($m) $m.type -eq 'participant_joined' -and $m.channelId -eq $chan1 } 60
    Check 'webhook participant_joined -> participant_joined no WebSocket' ($null -ne $joined -and $joined.participant.userId -eq $alice.Id -and $joined.participant.username -eq 'amiga' -and $joined.participant.isScreenSharing -eq $false) ($joined | ConvertTo-Json -Compress -Depth 5)

    $started = Wait-WsMessage $brunoWs { param($m) $m.type -eq 'stream_started' -and $m.channelId -eq $chan1 } 40
    Check 'publicar trilha de tela -> stream_started (source SCREEN_SHARE)' ($null -ne $started -and $started.userId -eq $alice.Id) ($started | ConvertTo-Json -Compress)

    if ($null -ne $started) {
        # Quem conecta no meio da transmissão já enxerga o estado certo no snapshot, com seq que não regride.
        $late = Connect-Ws 'dora-tardia' $dora.Session
        $who = Get-SnapshotChannel $late.Snapshot $chan1
        Check 'snapshot de quem conecta durante a transmissão mostra a pessoa transmitindo' ($who.Count -eq 1 -and $who[0].userId -eq $alice.Id -and $who[0].isScreenSharing -eq $true -and [long]$late.Snapshot.seq -ge [long]$started.seq) ($late.Snapshot | ConvertTo-Json -Compress -Depth 6)
    }

    $stopped = Wait-WsMessage $brunoWs { param($m) $m.type -eq 'stream_stopped' -and $m.channelId -eq $chan1 } 40
    Check 'despublicar a trilha -> stream_stopped' ($null -ne $stopped -and $stopped.userId -eq $alice.Id) ($stopped | ConvertTo-Json -Compress)

    Stop-Bot $botA
    $left = Wait-WsMessage $brunoWs { param($m) $m.type -eq 'participant_left' -and $m.channelId -eq $chan1 } 30
    Check 'sair da sala -> participant_left' ($null -ne $left -and $left.userId -eq $alice.Id) ($left | ConvertTo-Json -Compress)

    $null = Wait-WsMessage $doraWs { param($m) $m.type -eq 'participant_left' -and $m.channelId -eq $chan1 } 20
    $order = @($doraWs.Log | Where-Object { $_.channelId -eq $chan1 } | ForEach-Object { $_.type }) -join ','
    Check 'outro cliente conectado recebe a mesma sequência de eventos' ($order -eq 'participant_joined,stream_started,stream_stopped,participant_left') $order
    Check 'seq contíguo depois do snapshot (sem buracos)' ((Test-SeqContiguous $brunoWs) -and (Test-SeqContiguous $doraWs))

    Write-Host "`n=== Espectador (oculto) fica fora da presença ===" -ForegroundColor Cyan
    $hooksBefore = @(Get-BackendLog | Select-String -SimpleMatch '"/webhooks/livekit"').Count
    $spectatorToken = Get-LiveKitToken $alice.Session $chan1 'spectator'
    $botSpectator = Start-Bot 'espectador' $spectatorToken @('--leave-after', '6s')
    $noise = Read-WsFor $brunoWs 16
    Check 'espectador entra e sai sem gerar nenhum evento de presença' ($noise.Count -eq 0) ($noise | ConvertTo-Json -Compress -Depth 4)
    $botLog = (Get-ContainerLog $botSpectator) -join "`n"
    Check 'o espectador realmente conectou ao LiveKit' ($botLog -match 'conectado') $botLog
    $hooksAfter = @(Get-BackendLog | Select-String -SimpleMatch '"/webhooks/livekit"').Count
    Check 'o LiveKit enviou webhooks do espectador ao backend (que os ignorou)' ($hooksAfter -gt $hooksBefore) "antes=$hooksBefore depois=$hooksAfter"

    Write-Host "`n=== Menções ===" -ForegroundColor Cyan
    # Orçamento (MENTION_SENDER_LIMIT=4, MENTION_RECIPIENT_LIMIT=3 por 10 min): bruno gasta 4 e a 5ª é recusada.
    Send-Ws $brunoWs @{ type = 'mention'; targetUserId = $dora.Id; message = 'vem pra call'; ref = 'm1' }
    $got = Wait-WsMessage $doraWs { param($m) $m.type -eq 'mention' } 8
    Check 'menção entregue ao destinatário conectado (com remetente e mensagem)' ($null -ne $got -and $got.from.id -eq $bruno.Id -and $got.from.username -eq 'bruno' -and $got.message -eq 'vem pra call' -and $got.sentAt) ($got | ConvertTo-Json -Compress -Depth 4)
    $got2 = Wait-WsMessage $late { param($m) $m.type -eq 'mention' } 8
    Check 'menção chega a todas as conexões do destinatário' ($null -ne $got2 -and $got2.message -eq 'vem pra call')
    $ack = Wait-WsMessage $brunoWs { param($m) $m.type -eq 'mention_sent' } 8
    Check 'remetente recebe mention_sent com a ref' ($null -ne $ack -and $ack.ref -eq 'm1')

    Send-Ws $brunoWs @{ type = 'mention'; targetUserId = $carla.Id; ref = 'm2' }
    $e = Wait-WsMessage $brunoWs { param($m) $m.type -eq 'error' } 8
    Check 'menção a usuário offline -> erro recipient_offline' ($null -ne $e -and $e.code -eq 'recipient_offline' -and $e.ref -eq 'm2') ($e | ConvertTo-Json -Compress)

    Send-Ws $brunoWs @{ type = 'mention'; targetUserId = 'usuario-que-nao-existe'; ref = 'm3' }
    $e = Wait-WsMessage $brunoWs { param($m) $m.type -eq 'error' } 8
    Check 'menção a usuário inexistente -> erro unknown_user' ($null -ne $e -and $e.code -eq 'unknown_user') ($e | ConvertTo-Json -Compress)

    Send-Ws $brunoWs @{ type = 'mention'; targetUserId = $bruno.Id }
    $e = Wait-WsMessage $brunoWs { param($m) $m.type -eq 'error' } 8
    Check 'auto-menção -> erro self_mention' ($null -ne $e -and $e.code -eq 'self_mention')

    Send-Ws $brunoWs @{ type = 'mention'; targetUserId = $dora.Id; message = ('x' * 141) }
    $e = Wait-WsMessage $brunoWs { param($m) $m.type -eq 'error' } 8
    Check 'mensagem acima de 140 caracteres -> erro bad_message' ($null -ne $e -and $e.code -eq 'bad_message')

    Send-Ws $brunoWs @{ type = 'mention'; targetUserId = $dora.Id; ref = 'm4' }
    $null = Wait-WsMessage $doraWs { param($m) $m.type -eq 'mention' } 8
    $ack = Wait-WsMessage $brunoWs { param($m) $m.type -eq 'mention_sent' } 8
    Check '4ª menção do remetente ainda é entregue (dentro do limite)' ($null -ne $ack -and $ack.ref -eq 'm4')

    Send-Ws $brunoWs @{ type = 'mention'; targetUserId = $dora.Id; ref = 'm5' }
    $e = Wait-WsMessage $brunoWs { param($m) $m.type -eq 'error' } 8
    Check 'estouro do limite por remetente -> rate_limited_sender' ($null -ne $e -and $e.code -eq 'rate_limited_sender' -and $e.ref -eq 'm5') ($e | ConvertTo-Json -Compress)
    $extra = Read-WsFor $doraWs 1
    Check 'a menção recusada pelo limite não chegou ao destinatário' (@($extra | Where-Object { $_.type -eq 'mention' }).Count -eq 0)

    # Destinatário dora já recebeu 2 (de bruno); alice faz a 3ª e carla, a 4ª, que estoura o limite por destinatário.
    $aliceWs = Connect-Ws 'alice' $alice.Session
    $carlaWs = Connect-Ws 'carla' $carla.Session
    Send-Ws $aliceWs @{ type = 'mention'; targetUserId = $dora.Id; ref = 'a1' }
    $ack = Wait-WsMessage $aliceWs { param($m) $m.type -eq 'mention_sent' } 8
    Check '3ª menção ao mesmo destinatário (de outro remetente) é entregue' ($null -ne $ack -and $ack.ref -eq 'a1')
    Send-Ws $carlaWs @{ type = 'mention'; targetUserId = $dora.Id; ref = 'c1' }
    $e = Wait-WsMessage $carlaWs { param($m) $m.type -eq 'error' } 8
    Check 'estouro do limite por destinatário -> rate_limited_recipient' ($null -ne $e -and $e.code -eq 'rate_limited_recipient' -and $e.ref -eq 'c1') ($e | ConvertTo-Json -Compress)

    Write-Host "`n=== Limite de conexões por usuário ===" -ForegroundColor Cyan
    # WS_MAX_CONNS_PER_USER=3: a 4ª conexão da carla derruba a mais antiga em vez de barrar quem reconecta.
    $carlaWs2 = Connect-Ws 'carla-2' $carla.Session
    $carlaWs3 = Connect-Ws 'carla-3' $carla.Session
    $carlaWs4 = Connect-Ws 'carla-4' $carla.Session
    Check 'a 4ª conexão do mesmo usuário derruba a mais antiga (1008)' ((Wait-WsClosed $carlaWs 10) -and $carlaWs.CloseStatus -eq 1008)
    Check 'as conexões mais novas continuam abertas' (-not $carlaWs2.Closed -and -not $carlaWs3.Closed -and -not $carlaWs4.Closed -and $null -ne $carlaWs4.Snapshot)

    # Esta etapa vem ANTES do restart: o teste alcança o backend pela porta publicada na rede padrão do Docker,
    # e depois de um restart o Docker pode passar a encaminhar essa porta pela rede do teste (que vamos cortar).
    Write-Host "`n=== Reconciliação periódica (webhook perdido) ===" -ForegroundColor Cyan
    $carlaVoice = Get-LiveKitToken $carla.Session $chan2 'voice'
    $botB = Start-Bot 'carla' $carlaVoice @('--publish-screen-after', '1s')
    Check 'segunda sala: carla entra e transmite (precondição)' (Wait-UserSharing $brunoWs $chan2 $carla.Id 90)
    Check 'seq contíguo em toda a sessão do observador' (Test-SeqContiguous $brunoWs)

    $fixesBefore = @(Get-BackendLog | Select-String -SimpleMatch '"mudancas"').Count
    # Corta LiveKit<->backend. O LiveKit tenta entregar cada webhook por 20 a 30 s (5 tentativas, esperas de 1+2+4+8 s) e desiste;
    # esperar mais que isso garante que os webhooks da saída da carla se perderam de verdade.
    docker network disconnect $netName $apiName | Out-Null
    Stop-Bot $botB
    Write-Host '  (aguardando 40 s com o backend isolado do LiveKit...)'
    # Continua LENDO o WebSocket durante a espera: o backend faz ping a cada 20 s, e um cliente que não lê
    # não responde ao pong e é (corretamente) derrubado como conexão morta.
    $quiet = Read-WsFor $brunoWs 40
    Check 'nada chega ao observador durante o isolamento' ($quiet.Count -eq 0) ($quiet | ConvertTo-Json -Compress -Depth 4)
    $isolated = Connect-Ws 'durante-isolamento' $bruno.Session
    $stale = Get-SnapshotChannel $isolated.Snapshot $chan2
    Check 'durante o isolamento o backend ainda mostra a pessoa que já saiu (webhook perdido)' ($stale.Count -eq 1 -and $stale[0].userId -eq $carla.Id)
    docker network connect $netName $apiName | Out-Null
    $gone = Wait-WsMessage $brunoWs { param($m) $m.type -eq 'participant_left' -and $m.channelId -eq $chan2 } 45
    Check 'a reconciliação periódica corrige o estado e avisa os clientes (participant_left)' ($null -ne $gone -and $gone.userId -eq $carla.Id) ($gone | ConvertTo-Json -Compress)
    $fixesAfter = @(Get-BackendLog | Select-String -SimpleMatch '"mudancas"').Count
    Check 'o backend registrou que a reconciliação corrigiu a presença' ($fixesAfter -gt $fixesBefore) "antes=$fixesBefore depois=$fixesAfter"
    Check 'seq contíguo também depois da reconciliação' (Test-SeqContiguous $brunoWs)

    Write-Host "`n=== Reconciliação ao iniciar o backend ===" -ForegroundColor Cyan
    $botC = Start-Bot 'carla-2' $carlaVoice @('--publish-screen-after', '1s')
    Check 'carla volta à segunda sala e transmite (precondição)' (Wait-UserSharing $brunoWs $chan2 $carla.Id 90)

    # O estado em memória some com o processo. Nenhum webhook é reenviado: só a reconciliação inicial
    # (RoomService) pode devolver a carla ao snapshot.
    docker restart $apiName | Out-Null
    Check 'reiniciar o backend encerra os WebSockets com "going away" (1001)' ((Wait-WsClosed $brunoWs 15) -and $brunoWs.CloseStatus -eq 1001) "status $($brunoWs.CloseStatus)"
    if (-not (Wait-BackendReady)) { throw 'o backend não voltou após o restart' }

    $recovered = $false
    for ($i = 0; $i -lt 30 -and -not $recovered; $i++) {
        $candidate = Connect-Ws "bruno-pos-restart-$i" $bruno.Session
        $who = Get-SnapshotChannel $candidate.Snapshot $chan2
        if ($who.Count -eq 1 -and $who[0].userId -eq $carla.Id -and $who[0].isScreenSharing -eq $true) { $recovered = $true }
        else { Close-Ws $candidate; Start-Sleep -Seconds 1 }
    }
    Check 'após reiniciar, a reconciliação inicial recupera quem está na sala e transmitindo' $recovered
} catch {
    $script:failed++
    Write-Host "  ERRO    $($_.Exception.Message)" -ForegroundColor Red
} finally {
    if ($script:failed -gt 0) {
        Write-Host "`n--- logs do backend ---" -ForegroundColor Yellow
        Get-ContainerLog $apiName 40 | Out-Host
        Write-Host "`n--- logs do LiveKit ---" -ForegroundColor Yellow
        Get-ContainerLog $lkName 20 | Out-Host
        foreach ($bot in $script:bots) {
            Write-Host "`n--- logs do bot $bot ---" -ForegroundColor Yellow
            Get-ContainerLog $bot 15 | Out-Host
        }
    }
    Remove-E2eResources
    $http.Dispose()
}

Write-Host "`n=== Resultado do aceite ===" -ForegroundColor Cyan
Write-Host ("  {0} passaram, {1} falharam" -f $script:passed, $script:failed)
if ($script:failed -eq 0 -and $script:passed -gt 0) { $exitCode = 0 }
exit $exitCode
