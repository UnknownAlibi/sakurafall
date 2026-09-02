param(
  [string]$HostAlias = 'sakurafall',
  [string]$ServiceIp = '47.109.87.3',
  [string]$HealthUrl = 'https://47.109.87.3:8443/health'
)

$ErrorActionPreference = 'Stop'
$tunnel = $null

if ($HostAlias -notmatch '^[A-Za-z0-9._-]+$') {
  throw 'HostAlias contains unsupported characters.'
}
if ($ServiceIp -notmatch '^\d{1,3}(\.\d{1,3}){3}$') {
  throw 'ServiceIp must be an IPv4 address.'
}

try {
  $tunnel = Start-Process -FilePath 'ssh.exe' -ArgumentList @(
    '-NT',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-R', '127.0.0.1:10808',
    $HostAlias
  ) -WindowStyle Hidden -PassThru

  Start-Sleep -Seconds 2
  if ($tunnel.HasExited) {
    throw 'Could not establish the certificate renewal tunnel.'
  }

  $remoteScript = @"
set -euo pipefail
export HTTPS_PROXY=socks5h://127.0.0.1:10808
export HTTP_PROXY=socks5h://127.0.0.1:10808
lego run --path /etc/lego --email noemail@example.com --accept-tos --server letsencrypt --domains '$ServiceIp' --key-type EC256 --profile shortlived --tls --no-random-sleep
install -o root -g sakurafall -m 0644 '/etc/lego/certificates/$ServiceIp.crt' /etc/sakurafall/tls/server.crt
install -o root -g sakurafall -m 0640 '/etc/lego/certificates/$ServiceIp.key' /etc/sakurafall/tls/server.key
systemctl restart sakurafall
"@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($remoteScript -replace "`r", '')))
  & ssh $HostAlias "echo '$encoded' | base64 -d | bash"
  if ($LASTEXITCODE -ne 0) { throw 'Certificate renewal failed on the server.' }

  Start-Sleep -Seconds 2
  $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 10
  if (-not $health.ok) { throw 'The service failed its post-renewal health check.' }
  Write-Host 'SakuraFall IP certificate check completed successfully.'
} finally {
  if ($tunnel -and -not $tunnel.HasExited) {
    Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
    $tunnel.WaitForExit(3000) | Out-Null
  }
}
