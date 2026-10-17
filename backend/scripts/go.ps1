#Requires -Version 7.0
# Roda qualquer comando `go` na imagem golang:1.27. Exemplos:
#   pwsh -NoProfile -File scripts\go.ps1 build ./...
#   pwsh -NoProfile -File scripts\go.ps1 mod tidy
. "$PSScriptRoot\_docker.ps1"

if ($args.Count -eq 0) {
    Write-Error 'Uso: go.ps1 <argumentos do go>'
    exit 2
}
Exit-OnFailure (Invoke-Go -GoArgs $args)
