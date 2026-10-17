#Requires -Version 7.0
# Verificação completa do backend, tudo em contêiner:
#   1. generate (e falha se o código gerado commitado estiver desatualizado em relação ao contrato/SQL)
#   2. go build, go vet
#   3. go test -race
#   4. golangci-lint
# Roda todas as etapas mesmo que uma falhe, e mostra o resumo no fim. Código de saída != 0 se algo falhou.
. "$PSScriptRoot\_docker.ps1"

$backend = Join-Path $script:RepoRoot 'backend'
$results = [ordered]@{}

function Get-GeneratedHash {
    $files = @(Join-Path $backend 'internal\api\api.gen.go') + (Get-ChildItem (Join-Path $backend 'internal\store') -Filter '*.go' | ForEach-Object FullName)
    ($files | Sort-Object | ForEach-Object { (Get-FileHash $_ -Algorithm SHA256).Hash }) -join ','
}

function Add-Step {
    param([string]$Name, [scriptblock]$Action)
    Write-Host "`n=== $Name ===" -ForegroundColor Cyan
    $code = & $Action
    $results[$Name] = ($code -eq 0)
}

Add-Step 'generate (sem deriva)' {
    $before = Get-GeneratedHash
    $code = Invoke-Go -GoArgs @('generate', './...')
    if ($code -ne 0) { return $code }
    if ($before -ne (Get-GeneratedHash)) {
        Write-Host 'O código gerado mudou: o commit estava desatualizado em relação a contracts/openapi.yaml ou db/. Revise e inclua os arquivos gerados.' -ForegroundColor Yellow
        return 1
    }
    return 0
}
Add-Step 'go build' { Invoke-Go -GoArgs @('build', './...') }
Add-Step 'go vet' { Invoke-Go -GoArgs @('vet', './...') }
Add-Step 'go test -race' { Invoke-Go -GoArgs @('test', '-race', '-count=1', './...') }
Add-Step 'golangci-lint' { Invoke-Container -Image $script:LintImage -Command @('golangci-lint', 'run', './...') }

Write-Host "`n=== Resumo ===" -ForegroundColor Cyan
$failed = 0
foreach ($step in $results.GetEnumerator()) {
    if ($step.Value) { Write-Host ("  PASSOU  {0}" -f $step.Key) -ForegroundColor Green }
    else { Write-Host ("  FALHOU  {0}" -f $step.Key) -ForegroundColor Red; $failed++ }
}
exit $(if ($failed -eq 0) { 0 } else { 1 })
