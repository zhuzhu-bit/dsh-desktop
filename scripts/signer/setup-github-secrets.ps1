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

# Key (ASCII-only minisign file): pipe via stdin is safe.
Get-Content $key -Raw | gh secret set TAURI_SIGNING_PRIVATE_KEY --repo $Repo --env release
if ($LASTEXITCODE -ne 0) { throw 'failed to set TAURI_SIGNING_PRIVATE_KEY' }

# Password: set INTERACTIVELY through gh itself. Piping strings into gh from
# PowerShell re-encodes them through the console codepage, which corrupts any
# non-ASCII password (this bit us in CI: "Wrong password for that key").
# gh prompts a masked input — paste the password and press Enter.
Write-Host 'gh will now ask for the key password (masked). Paste it, then press Enter.'
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo $Repo --env release
if ($LASTEXITCODE -ne 0) { throw 'failed to set TAURI_SIGNING_PRIVATE_KEY_PASSWORD' }

Write-Host ''
Write-Host 'Verification tips:'
Write-Host '  - test the password locally first (should print a successful signature):'
Write-Host '      npm exec -- tauri signer sign --private-key "%USERPROFILE%\.dsh-desktop\updater\dsh-desktop.key" LICENSE'
Write-Host '  - delete the generated LICENSE.sig afterwards.'
Write-Host 'Reminder: keep an encrypted offline backup of the private key; losing'
Write-Host 'it means installed clients can never verify future updates.'
