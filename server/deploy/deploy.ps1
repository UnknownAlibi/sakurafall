param(
  [string]$HostAlias = 'sakurafall',
  [string]$HealthUrl = 'https://47.109.87.3:8443/health'
)

$ErrorActionPreference = 'Stop'

if ($HostAlias -notmatch '^[A-Za-z0-9._-]+$') {
  throw 'HostAlias contains unsupported characters.'
}

$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$archive = Join-Path ([IO.Path]::GetTempPath()) "sakurafall-server-$stamp.tar.gz"
$remoteArchive = "/tmp/sakurafall-server-$stamp.tar.gz"
$release = "/opt/sakurafall/releases/$stamp"

try {
  & tar -czf $archive server
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the server archive.' }

  & scp -q $archive "${HostAlias}:$remoteArchive"
  if ($LASTEXITCODE -ne 0) { throw 'Could not upload the server archive.' }

  $remoteCommand = @(
    'set -euo pipefail'
    "mkdir -p '$release'"
    "tar -xzf '$remoteArchive' -C '$release'"
    "chown -R sakurafall:sakurafall '$release'"
    "ln -sfn '$release/server' /opt/sakurafall/server"
    'systemctl restart sakurafall'
    'sleep 2'
    'systemctl is-active --quiet sakurafall'
    "rm -f '$remoteArchive'"
  ) -join '; '

  & ssh $HostAlias $remoteCommand
  if ($LASTEXITCODE -ne 0) { throw 'The remote deployment failed.' }

  $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 10
  if (-not $health.ok) { throw 'The deployed service did not pass its health check.' }
  Write-Host "SakuraFall service deployed: $release"
} finally {
  if (Test-Path -LiteralPath $archive) {
    Remove-Item -LiteralPath $archive -Force
  }
}
