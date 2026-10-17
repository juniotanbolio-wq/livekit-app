# golangci-lint em contêiner (imagem oficial, versão fixada em _docker.ps1). Configuração em .golangci.yml.
. "$PSScriptRoot\_docker.ps1"

$lintArgs = if ($args.Count -gt 0) { $args } else { @('./...') }
Exit-OnFailure (Invoke-Container -Image $script:LintImage -Command (@('golangci-lint', 'run') + $lintArgs))
