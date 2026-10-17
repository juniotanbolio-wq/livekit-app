# go test -race em contêiner. A imagem golang:1.27 (Debian) já traz gcc, que o detector de corridas exige.
# Argumentos extras vão direto ao `go test`, por exemplo: test.ps1 -run TestRegister ./internal/httpapi
. "$PSScriptRoot\_docker.ps1"

$goArgs = if ($args.Count -gt 0) { $args } else { @('./...') }
# -count=1 desliga o cache de resultados: o aceite precisa rodar de verdade.
Exit-OnFailure (Invoke-Go -GoArgs (@('test', '-race', '-count=1') + $goArgs))
