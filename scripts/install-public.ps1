param([switch]$DryRun, [switch]$NoOpen)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
  throw 'Install Node.js 24+ (including npm), then run this command again.'
}
& node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)'
if ($LASTEXITCODE -ne 0) { throw 'Node.js 24+ is required.' }
$version = if ($env:CHIMERA_VERSION) { $env:CHIMERA_VERSION } else { 'latest' }
$arguments = @('exec', '--yes', '--registry=https://registry.npmjs.org', "--package=@nedimyilmaz/chimera@$version", '--', 'chimera', 'install')
if ($DryRun) { $arguments += '--dry-run' }
if ($NoOpen) { $arguments += '--no-open' }
& npm.cmd @arguments
if ($LASTEXITCODE -ne 0) { throw "Chimera installation failed ($LASTEXITCODE)." }
