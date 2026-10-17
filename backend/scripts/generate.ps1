#Requires -Version 7.0
# Regenera o código derivado: servidor a partir de contracts/openapi.yaml (oapi-codegen) e
# consultas SQL (sqlc). As versões das ferramentas ficam fixadas em go.mod (diretivas `tool`).
. "$PSScriptRoot\_docker.ps1"

Exit-OnFailure (Invoke-Go -GoArgs @('generate', './...'))
