#Requires -Version 7.0
# Funções comuns dos scripts do backend. Não é para ser executado direto: os outros scripts fazem dot-source.
#
# O Windows de desenvolvimento não tem Go, gcc nem golangci-lint. Tudo roda em contêiner, com o repositório
# inteiro montado em /repo (o `generate` precisa ler contracts/openapi.yaml, que fica fora de backend/).

$ErrorActionPreference = 'Stop'

$script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script:GoImage = 'golang:1.27'
# Versão fixada para o lint ser reproduzível; a imagem precisa trazer Go >= ao do go.mod.
$script:LintImage = 'golangci/golangci-lint:v2.15.0'

function Assert-Docker {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Docker não encontrado no PATH. Abra o Docker Desktop e tente de novo.'
    }
    docker info --format '{{.ServerVersion}}' *> $null
    if ($LASTEXITCODE -ne 0) {
        throw 'O Docker Desktop não está em execução.'
    }
}

# Executa um comando dentro de um contêiner efêmero, com os caches do Go em volumes nomeados
# (sem eles cada execução rebaixaria todas as dependências).
# GOFLAGS=-buildvcs=false: o git do contêiner reclama de "dubious ownership" no bind mount do Windows.
function Invoke-Container {
    param(
        [Parameter(Mandatory)][string]$Image,
        [Parameter(Mandatory)][string[]]$Command,
        [string[]]$ExtraArgs = @()
    )
    Assert-Docker
    $dockerArgs = @(
        'run', '--rm',
        '-v', "$($script:RepoRoot):/repo",
        '-v', 'livekit-go-mod:/go/pkg/mod',
        '-v', 'livekit-go-build:/root/.cache/go-build',
        '-v', 'livekit-lint-cache:/root/.cache/golangci-lint',
        '-e', 'GOFLAGS=-buildvcs=false',
        '-w', '/repo/backend'
    ) + $ExtraArgs + @($Image) + $Command
    # Out-Host: a saída do contêiner vai para o console e não "vaza" para o valor de retorno da função.
    & docker @dockerArgs | Out-Host
    return $LASTEXITCODE
}

function Invoke-Go {
    param([Parameter(Mandatory)][string[]]$GoArgs, [string[]]$ExtraArgs = @())
    return Invoke-Container -Image $script:GoImage -Command (@('go') + $GoArgs) -ExtraArgs $ExtraArgs
}

function Exit-OnFailure {
    param([int]$Code)
    if ($Code -ne 0) { exit $Code }
}
