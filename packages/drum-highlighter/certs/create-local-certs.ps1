param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$certDir = $PSScriptRoot
$certPath = Join-Path $certDir 'local-cert.pem'
$keyPath = Join-Path $certDir 'local-key.pem'

if (!$Force -and (Test-Path -LiteralPath $certPath) -and (Test-Path -LiteralPath $keyPath)) {
    Write-Host "Certificate files already exist:"
    Write-Host "  $certPath"
    Write-Host "  $keyPath"
    Write-Host "Use -Force to recreate them."
    exit 0
}

$mkcert = Get-Command mkcert -ErrorAction SilentlyContinue
if (!$mkcert) {
    Write-Error @"
mkcert was not found.

Install it first, then rerun this script:
  winget install FiloSottile.mkcert
  mkcert -install

Then run:
  .\create-local-certs.ps1

The generated files will be:
  local-cert.pem
  local-key.pem
"@
}

$hostNames = New-Object System.Collections.Generic.List[string]
$hostNames.Add('localhost')
$hostNames.Add('127.0.0.1')

Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object {
        $_.IPAddress -notlike '169.254.*' -and
        $_.IPAddress -ne '127.0.0.1' -and
        $_.PrefixOrigin -ne 'WellKnown'
    } |
    ForEach-Object {
        if (!$hostNames.Contains($_.IPAddress)) {
            $hostNames.Add($_.IPAddress)
        }
    }

Push-Location $certDir
try {
    & $mkcert.Source -cert-file 'local-cert.pem' -key-file 'local-key.pem' @hostNames
}
finally {
    Pop-Location
}

Write-Host "Created local HTTPS certificate files:"
Write-Host "  $certPath"
Write-Host "  $keyPath"
Write-Host ""
Write-Host "If you test from an iPad, install and trust the mkcert root CA on the iPad."
