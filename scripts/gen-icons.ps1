# Regenerates the Windows icons from the checked-in square source image.
# Run from the project root:
#   powershell -ExecutionPolicy Bypass -File scripts\gen-icons.ps1
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceIcon = Join-Path $projectRoot 'src-tauri\icons\icon-source.png'
$iconsDir = Join-Path $projectRoot 'src-tauri\icons'
$stagingDir = Join-Path $projectRoot 'src-tauri\.icon-staging'

if (-not (Test-Path -LiteralPath $sourceIcon -PathType Leaf)) {
    throw "Icon source not found: $sourceIcon"
}

# Validate the recursive-cleanup target before touching it.
$srcTauriDir = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'src-tauri'))
$stagingFullPath = [System.IO.Path]::GetFullPath($stagingDir)
$expectedPrefix = $srcTauriDir.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $stagingFullPath.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe icon staging path: $stagingFullPath"
}

if (Test-Path -LiteralPath $stagingFullPath) {
    Remove-Item -LiteralPath $stagingFullPath -Recurse -Force
}
New-Item -ItemType Directory -Path $stagingFullPath | Out-Null

$requiredIcons = @(
    '32x32.png',
    '128x128.png',
    '128x128@2x.png',
    'icon.png',
    'icon.ico'
)

Push-Location $projectRoot
try {
    & npm.cmd run tauri icon -- $sourceIcon --output $stagingFullPath
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri icon generation failed with exit code $LASTEXITCODE"
    }

    foreach ($name in $requiredIcons) {
        $generatedPath = Join-Path $stagingFullPath $name
        if (-not (Test-Path -LiteralPath $generatedPath -PathType Leaf)) {
            throw "Tauri did not generate required icon: $generatedPath"
        }
        Copy-Item -LiteralPath $generatedPath -Destination (Join-Path $iconsDir $name) -Force
    }
}
finally {
    Pop-Location
    if (Test-Path -LiteralPath $stagingFullPath) {
        Remove-Item -LiteralPath $stagingFullPath -Recurse -Force
    }
}

Get-Item ($requiredIcons | ForEach-Object { Join-Path $iconsDir $_ }) |
    Select-Object Name, Length |
    Format-Table -AutoSize
