#Requires -Version 7.0
# "Iniciar teste": sobe o servidor de desenvolvimento (infra/docker-compose.yml: LiveKit + backend) e abre duas
# instâncias do app empacotado neste PC, a segunda com perfil separado, para testar voz, tela e Modo Espectador.
#
#   pwsh -NoProfile -File infra\scripts\iniciar-teste.ps1 [-Rebuild] [-Convites 2] [-Pausar]
#
#   -Rebuild    recompila a imagem do backend (compose up --build) e o app (npm run package)
#   -Convites   gera N convites de uso único e mostra os códigos (para cadastrar contas novas)
#   -Pausar     espera Enter no fim (o atalho da área de trabalho usa, para a janela não sumir com o resultado)
#
# Atalho na área de trabalho: pwsh -NoProfile -File infra\scripts\criar-atalho.ps1
param(
    [switch]$Rebuild,
    [ValidateRange(0, 10)][int]$Convites = 0,
    [switch]$Pausar
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$infra = Join-Path $repo 'infra'
$frontend = Join-Path $repo 'frontend'
$compose = Join-Path $infra 'docker-compose.yml'
$envFile = Join-Path $infra '.env'
$serverUrl = 'http://localhost:8080'
$exe = Join-Path $frontend 'dist\win-unpacked\LiveKit App.exe'
# Perfil próprio da segunda instância: sessão, servidor salvo e dispositivos separados dos da primeira.
$secondProfile = Join-Path $env:LOCALAPPDATA 'LiveKitApp-teste\B'

function Write-Step([string]$Text) { Write-Host "`n> $Text" -ForegroundColor Cyan }

function Exit-Script([int]$Code) {
    if ($Pausar) { [void](Read-Host 'Pressione Enter para fechar') }
    exit $Code
}

function Stop-WithError([string]$Text) {
    Write-Host "ERRO: $Text" -ForegroundColor Red
    Exit-Script 1
}

function Test-DockerUp {
    & docker info --format '{{.ServerVersion}}' *> $null
    return $LASTEXITCODE -eq 0
}

try {
    Write-Step 'Conferindo o Docker'
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Stop-WithError 'Docker não encontrado. Instale o Docker Desktop: https://docs.docker.com/desktop/'
    }
    if (-not (Test-DockerUp)) {
        $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
        if (-not (Test-Path $desktop)) {
            Stop-WithError "O Docker não está em execução e o Docker Desktop não foi encontrado em $desktop. Abra-o e tente de novo."
        }
        Write-Host 'Abrindo o Docker Desktop (pode levar até 3 minutos)...'
        Start-Process -FilePath $desktop
        $deadline = (Get-Date).AddMinutes(3)
        while (-not (Test-DockerUp)) {
            if ((Get-Date) -gt $deadline) { Stop-WithError 'O Docker Desktop não ficou pronto em 3 minutos.' }
            Start-Sleep -Seconds 3
        }
    }
    Write-Host 'Docker pronto.'

    # Só confere que os segredos existem; os valores nunca são lidos para a tela.
    if (-not (Test-Path $envFile)) {
        Stop-WithError "Falta infra\.env. Copie infra\.env.example para infra\.env e preencha os segredos (veja infra\README.md)."
    }
    $envText = Get-Content $envFile -Raw
    foreach ($key in 'LIVEKIT_API_SECRET', 'JWT_SECRET') {
        if ($envText -notmatch "(?m)^\s*$key\s*=\s*\S{32,}") {
            Stop-WithError "infra\.env sem $key (32+ caracteres)."
        }
    }

    Write-Step 'Subindo o servidor de desenvolvimento (LiveKit + backend)'
    $upArgs = @('compose', '-f', $compose, 'up', '-d')
    if ($Rebuild) { $upArgs += '--build' }
    & docker @upArgs
    if ($LASTEXITCODE -ne 0) { Stop-WithError 'docker compose up falhou (veja a mensagem acima).' }

    $deadline = (Get-Date).AddSeconds(90)
    $healthy = $false
    while (-not $healthy -and (Get-Date) -lt $deadline) {
        try {
            $health = Invoke-RestMethod -Uri "$serverUrl/health" -TimeoutSec 3
            $healthy = $health.status -eq 'ok'
        } catch {
            $healthy = $false
        }
        if (-not $healthy) { Start-Sleep -Seconds 2 }
    }
    if (-not $healthy) { Stop-WithError "O backend não respondeu em $serverUrl/health em 90 s (docker compose -f infra\docker-compose.yml logs backend)." }
    Write-Host "Backend respondendo em $serverUrl."

    # Idempotente: garante os 7 canais e o admin do infra\.env.
    & docker compose -f $compose exec -T backend /server seed | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-WithError 'O seed do backend falhou.' }

    if ($Convites -gt 0) {
        Write-Step "Gerando $Convites convite(s) de uso único (valem 72 h)"
        for ($i = 0; $i -lt $Convites; $i++) {
            & docker compose -f $compose exec -T backend /server invite create
            if ($LASTEXITCODE -ne 0) { Stop-WithError 'Falha ao gerar convite.' }
        }
    }

    Write-Step 'Preparando o app'
    if ($Rebuild -or -not (Test-Path $exe)) {
        if (-not (Test-Path (Join-Path $frontend 'node_modules'))) {
            Stop-WithError 'Dependências do frontend ausentes: rode "npm install" em frontend\ uma vez.'
        }
        Write-Host 'Empacotando o app (npm run package, 1 a 3 minutos)...'
        Push-Location $frontend
        try {
            & npm run package
            if ($LASTEXITCODE -ne 0) { Stop-WithError 'npm run package falhou.' }
        } finally {
            Pop-Location
        }
    }
    if (-not (Test-Path $exe)) { Stop-WithError "Executável não encontrado em $exe." }

    Write-Step 'Abrindo duas instâncias'
    # O VS Code exporta ELECTRON_RUN_AS_NODE; herdado, ele faria o app rodar como Node em vez de abrir a janela.
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $secondProfile | Out-Null
    Start-Process -FilePath $exe -ArgumentList @("--default-server-url=$serverUrl")
    Start-Sleep -Seconds 2
    Start-Process -FilePath $exe -ArgumentList @(
        '--multi-instance',
        "--user-data-dir=`"$secondProfile`"",
        "--default-server-url=$serverUrl"
    )

    Write-Host ''
    Write-Host 'Pronto.' -ForegroundColor Green
    Write-Host "  Instância A: perfil padrão (%APPDATA%\LiveKit App)."
    Write-Host "  Instância B: perfil $secondProfile."
    Write-Host "  Na primeira vez, cada uma pede o servidor: confirme $serverUrl e entre (ou cadastre-se com um convite)."
    Write-Host '  Painel de depuração: Ctrl+Shift+D. Convites: rode de novo com -Convites 2.'
    Write-Host '  Para parar o servidor: docker compose -f infra\docker-compose.yml stop'
    Exit-Script 0
} catch {
    Stop-WithError $_.Exception.Message
}
