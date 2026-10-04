param(
  [Parameter(Mandatory = $true)][string[]]$Artifacts,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Fa-f0-9]{40}$')][string]$ExpectedThumbprint
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Authenticode verification must run on Windows.' }
# Exact paths only: verify both the shipped installer and its application exe.
# No certificate import, signing, downloads, execution-policy changes or build.
foreach ($artifact in $Artifacts) {
  $item = Get-Item -LiteralPath $artifact
  if ($item.PSIsContainer -or $item.Extension -notin @('.exe', '.msi')) { throw 'Expected an exact EXE or MSI artifact path.' }
  $signature = Get-AuthenticodeSignature -LiteralPath $item.FullName
  if ($signature.Status -ne 'Valid') { throw "Invalid or missing Authenticode signature: $($item.Name)" }
  if ($signature.SignerCertificate.Thumbprint -ne $ExpectedThumbprint) { throw "Unexpected publisher: $($item.Name)" }
  if ($null -eq $signature.TimeStamperCertificate) { throw "Missing trusted timestamp: $($item.Name)" }
  $hash = Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256
  Write-Output "$($hash.Hash.ToLowerInvariant())  $($item.Name)"
}
