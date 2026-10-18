#Requires -Version 7.0
# Cria o atalho "Iniciar teste" na área de trabalho, que roda infra\scripts\iniciar-teste.ps1 numa janela do
# PowerShell 7 e espera Enter no fim (para dar tempo de ler o resultado ou o erro).
#
#   pwsh -NoProfile -File infra\scripts\criar-atalho.ps1
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script = Join-Path $PSScriptRoot 'iniciar-teste.ps1'
$pwsh = (Get-Command pwsh -ErrorAction Stop).Source
# GetFolderPath acompanha a área de trabalho redirecionada (OneDrive), ao contrário de $HOME\Desktop.
$desktop = [Environment]::GetFolderPath('Desktop')
$link = Join-Path $desktop 'Iniciar teste.lnk'
$exe = Join-Path $repo 'frontend\dist\win-unpacked\LiveKit App.exe'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = $pwsh
$shortcut.Arguments = "-NoProfile -File `"$script`" -Pausar"
$shortcut.WorkingDirectory = $repo
$shortcut.Description = 'Sobe o servidor de desenvolvimento e abre duas instâncias do LiveKit App'
$shortcut.IconLocation = if (Test-Path $exe) { "$exe,0" } else { "$pwsh,0" }
$shortcut.Save()

Write-Host "Atalho criado: $link"
