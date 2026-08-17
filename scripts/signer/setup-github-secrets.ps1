# Push the updater signing secrets into the GitHub `release` environment.
# Run this in your own terminal AFTER generate-key.ps1 and `gh auth login`.
#
#   powershell -ExecutionPolicy Bypass -File scripts\signer\setup-github-secrets.ps1
#
# Reads the private key from %USERPROFILE%\.dsh-desktop\updater\dsh-desktop.key
# and asks (masked) for its password. The key content passes through your
# terminal into `gh secret set` only — never into this repository.
param(
    [string]$Repo = 'zhuzhu-bit/dsh-desktop'
)
$ErrorActionPreference = 'Stop'

$key = Join-Path $env:USERPROFILE '.dsh-desktop\updater\dsh-desktop.key'
if (-not (Test-Path $key)) {
    throw "Key not found: $key — run generate-key.ps1 first."
}

gh auth status 2>$null
if ($LASTEXITCODE -ne 0) {
    throw 'gh is not authenticated. Run `gh auth login` in your terminal first.'
}

gh api --method PUT "repos/$Repo/environments/release" | Out-Null
Write-Host "environment 'release' ready on $Repo"

$secure = Read-Host 'Key password (masked)' -AsSecureString
$password = [System.Net.NetworkCredential]::new('', $secure).Password

Get-Content $key -Raw | gh secret set TAURI_SIGNING_PRIVATE_KEY --repo $Repo --env release
if ($LASTEXITCODE -ne 0) { throw 'failed to set TAURI_SIGNING_PRIVATE_KEY' }
$password | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo $Repo --env release
if ($LASTEXITCODE -ne 0) { throw 'failed to set TAURI_SIGNING_PRIVATE_KEY_PASSWORD' }

Write-Host 'Secrets set on the release environment.'
Write-Host 'Reminder: keep an encrypted offline backup of the private key; losing'
Write-Host 'it means installed clients can never verify future updates.'
