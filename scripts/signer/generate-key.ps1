# Generates the Tauri updater signing key pair OUTSIDE the repository.
# Run this in your own terminal (it prompts for the key password).
#
#   powershell -ExecutionPolicy Bypass -File scripts\signer\generate-key.ps1
#
# - Key file:   %USERPROFILE%\.dsh-desktop\updater\dsh-desktop.key   (PRIVATE — never commit)
# - Pub key:    %USERPROFILE%\.dsh-desktop\updater\dsh-desktop.key.pub
# - The private key is also expected to be copied to your encrypted offline
#   backup; verify that copy reads back before deleting anything.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dir = Join-Path $env:USERPROFILE '.dsh-desktop\updater'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$key = Join-Path $dir 'dsh-desktop.key'

if (Test-Path $key) {
    Write-Host "Key already exists: $key"
    Write-Host 'Delete it manually if you really want to regenerate.'
    exit 0
}

Set-Location $root
Write-Host 'The tauri signer will now ask for a password. Choose a strong one'
Write-Host 'and store it with your offline backup. Nothing is echoed to logs.'
npm exec -- tauri signer generate -w $key
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ''
Write-Host 'Generated:'
Write-Host "  private : $key"
Write-Host "  public  : $key.pub"
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1. Copy the private key to your encrypted offline backup and verify'
Write-Host '     you can read it back.'
Write-Host '  2. Run scripts\signer\setup-github-secrets.ps1 (requires gh login).'
