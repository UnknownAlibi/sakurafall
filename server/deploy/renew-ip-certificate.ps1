param(
  [string]$HostAlias = 'sakurafall',
  [string]$ServiceIp = '47.109.87.3',
  [string]$HealthUrl = 'https://47.109.87.3:8443/health'
)

$ErrorActionPreference = 'Stop'

if ($HostAlias -notmatch '^[A-Za-z0-9._-]+$') {
  throw 'HostAlias contains unsupported characters.'
}
if ($ServiceIp -notmatch '^\d{1,3}(\.\d{1,3}){3}$') {
  throw 'ServiceIp must be an IPv4 address.'
}

# lego v5 起子命令化：`lego run`，且存储目录改为环境变量 LEGO_PATH。
# 旧脚本用的是 v4 语法（`lego --path ... run`），在 v5 上会直接报
# "flag provided but not defined: -path"，导致证书到期后无人续期。
# 另外说明：Let's Encrypt 从这台 ECS 可直连（实测 200），不再需要经本机
# 10808 代理打反向隧道；少一层依赖，续期任务更不容易因为代理没开而失败。
$remoteScript = @"
set -euo pipefail
# sudo 的 secure_path 不含 /usr/local/bin，必须用绝对路径调用 lego
test -x /usr/local/bin/lego
LEGO_PATH=/etc/lego /usr/local/bin/lego run --accept-tos -m noemail@example.com -s letsencrypt \
  -d '$ServiceIp' -k EC256 --profile shortlived --tls --renew-force --no-random-sleep
install -o root -g sakurafall -m 0644 '/etc/lego/certificates/$ServiceIp.crt' /etc/sakurafall/tls/server.crt
install -o root -g sakurafall -m 0640 '/etc/lego/certificates/$ServiceIp.key' /etc/sakurafall/tls/server.key
systemctl restart sakurafall
"@
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($remoteScript -replace "`r", '')))

& ssh $HostAlias "echo '$encoded' | base64 -d | sudo -n bash"
if ($LASTEXITCODE -ne 0) { throw 'Certificate renewal failed on the server.' }

Start-Sleep -Seconds 3
# 证书是 IP 证书，公网访问能正常校验，这里不再需要跳过 TLS 校验
$health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 15
if (-not $health.ok) { throw 'The service failed its post-renewal health check.' }
Write-Host 'SakuraFall IP certificate renewed and service health verified.'
