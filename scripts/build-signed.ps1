# Builds, signs and verifies the Frameblade Windows installer.
# Usage:
#   npm run dist:signed -- -Thumbprint <certificate thumbprint>
#
# The certificate must be in the current user's Personal store. For Certum
# SimplySign, start SimplySign Desktop and authenticate before running this.
# Never put a PIN, private key or PFX password in the repository.

param(
    [Parameter(Mandatory = $true)]
    [string]$Thumbprint,

    [string]$TimestampUrl = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$normalizedThumbprint = ($Thumbprint -replace '\s', '').ToUpperInvariant()
$codeSigningOid = '1.3.6.1.5.5.7.3.3'

Push-Location $root
try {
    $cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
        Where-Object { $_.Thumbprint -eq $normalizedThumbprint } |
        Select-Object -First 1

    if (-not $cert) {
        $cert = Get-ChildItem Cert:\CurrentUser\My -ErrorAction SilentlyContinue |
            Where-Object { $_.Thumbprint -eq $normalizedThumbprint } |
            Select-Object -First 1
    }

    if (-not $cert) {
        throw "No certificate with thumbprint $normalizedThumbprint was found in Cert:\CurrentUser\My. Start SimplySign Desktop, install the certificate, and try again."
    }

    $hasCodeSigningEku = $cert.EnhancedKeyUsageList |
        Where-Object { $_.ObjectId -eq $codeSigningOid } |
        Select-Object -First 1

    if (-not $hasCodeSigningEku) {
        throw "Certificate $normalizedThumbprint does not have the Code Signing EKU ($codeSigningOid)."
    }

    if ($cert.NotAfter -lt (Get-Date)) {
        throw "Certificate $normalizedThumbprint expired on $($cert.NotAfter)."
    }

    Write-Host "Certificate: $($cert.Subject)"
    Write-Host "Issuer:      $($cert.Issuer)"
    Write-Host "Expires:     $($cert.NotAfter)"
    Write-Host "Thumbprint:  $($cert.Thumbprint)"

    if (-not $cert.HasPrivateKey) {
        Write-Warning 'The certificate does not currently report a private key. SimplySign Desktop must be running when signtool asks for the key.'
    }

    $env:FRAMEBLADE_CERT_SHA1 = $cert.Thumbprint
    $env:FRAMEBLADE_REQUIRE_SIGNING = '1'
    $env:FRAMEBLADE_TIMESTAMP_URL = $TimestampUrl

    Write-Host ''
    Write-Host 'Building and signing the installer...'
    & npm run dist
    if ($LASTEXITCODE -ne 0) {
        throw "npm run dist failed with exit code $LASTEXITCODE."
    }

    $pkg = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
    $version = $pkg.version
    $installer = Join-Path $root "release\Frameblade-$version-Setup.exe"
    $appExe = Join-Path $root 'release\win-unpacked\Frameblade.exe'

    $filesToVerify = @($appExe, $installer)
    foreach ($file in $filesToVerify) {
        if (-not (Test-Path -LiteralPath $file)) {
            throw "Expected signed file is missing: $file"
        }

        $signature = Get-AuthenticodeSignature -LiteralPath $file
        if ($signature.Status -ne 'Valid') {
            throw "Signature is not valid for $file`: $($signature.Status) - $($signature.StatusMessage)"
        }
        if (-not $signature.SignerCertificate) {
            throw "No signer certificate found for $file."
        }
        if (-not $signature.TimeStamperCertificate) {
            throw "Signature for $file is not timestamped. Refusing to publish a signature that cannot outlive the certificate."
        }

        Write-Host ''
        Write-Host "Verified: $(Split-Path -Leaf $file)"
        Write-Host "  Signer:    $($signature.SignerCertificate.Subject)"
        Write-Host "  Timestamp: $($signature.TimeStamperCertificate.NotBefore)"
    }

    $releaseFiles = @($installer)
    $sourceZip = Join-Path $root "release\Frameblade-$version-source.zip"
    if (Test-Path -LiteralPath $sourceZip) {
        $releaseFiles += $sourceZip
    }

    $sums = foreach ($file in $releaseFiles) {
        $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash  $(Split-Path -Leaf $file)"
    }
    $sumsPath = Join-Path $root 'release\SHA256SUMS.txt'
    $sums | Set-Content -LiteralPath $sumsPath -Encoding ascii

    Write-Host ''
    Write-Host 'Release checksums:'
    Get-Content -LiteralPath $sumsPath
    Write-Host ''
    Write-Host 'Next: upload the installer and SHA256SUMS.txt to the GitHub release, then verify the public download.'
} finally {
    Remove-Item Env:FRAMEBLADE_CERT_SHA1 -ErrorAction SilentlyContinue
    Remove-Item Env:FRAMEBLADE_REQUIRE_SIGNING -ErrorAction SilentlyContinue
    Remove-Item Env:FRAMEBLADE_TIMESTAMP_URL -ErrorAction SilentlyContinue
    Pop-Location
}
