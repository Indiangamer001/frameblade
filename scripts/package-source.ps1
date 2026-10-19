# Builds the source-only archive used for GitHub (no node_modules, build output or
# binaries). Run via: npm run source:zip
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$pkg = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = $pkg.version
$outDir = Join-Path $root 'release'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$stageRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('frameblade-source-' + [guid]::NewGuid().ToString('N'))
$stage = Join-Path $stageRoot 'frameblade'
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$skip = @('node_modules', 'dist', 'release', 'build', '.git', 'signed', 'signed-release')
Get-ChildItem -LiteralPath $root -Force | Where-Object {
    $skip -notcontains $_.Name -and $_.Name -notlike 'release-*' -and $_.Extension -ne '.log'
} | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $stage -Recurse -Force
}

$zip = Join-Path $outDir ("Frameblade-$version-source.zip")
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }

# Build the archive entry-by-entry so dotfiles are included and paths always use
# forward slashes (CreateDirectory on .NET Framework stores backslashes on Windows).
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipStream = [System.IO.File]::Open($zip, [System.IO.FileMode]::Create)
$archive = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    Get-ChildItem -LiteralPath $stage -Recurse -Force -File | ForEach-Object {
        $rel = $_.FullName.Substring($stage.Length + 1).Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive,
            $_.FullName,
            "frameblade/$rel",
            [System.IO.Compression.CompressionLevel]::Optimal
        ) | Out-Null
    }
} finally {
    $archive.Dispose()
    $zipStream.Dispose()
}
Remove-Item -LiteralPath $stageRoot -Recurse -Force

$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
"$hash  $(Split-Path -Leaf $zip)" | Set-Content -LiteralPath "$zip.sha256" -Encoding ascii

$size = [math]::Round((Get-Item -LiteralPath $zip).Length / 1MB, 1)
Write-Output "Created $zip ($size MB)"
Write-Output "SHA-256 $hash"
