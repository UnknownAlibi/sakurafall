const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

function powershellLiteral(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function normalizeRows(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function summarizeByRole(rows = []) {
  const roles = {};
  for (const row of rows) {
    const role = row.role || 'other';
    const summary = roles[role] || { count: 0, workingSetMB: 0, privateMB: 0, cpuSeconds: 0 };
    summary.count += 1;
    summary.workingSetMB += Number(row.workingSetMB) || 0;
    summary.privateMB += Number(row.privateMB) || 0;
    summary.cpuSeconds += Number(row.cpuSeconds) || 0;
    roles[role] = summary;
  }
  for (const summary of Object.values(roles)) {
    summary.workingSetMB = Number(summary.workingSetMB.toFixed(2));
    summary.privateMB = Number(summary.privateMB.toFixed(2));
    summary.cpuSeconds = Number(summary.cpuSeconds.toFixed(3));
  }
  return roles;
}

function linearSlope(values) {
  if (!Array.isArray(values) || values.length < 2) return 0;
  const normalized = values.map(value => Number(value) || 0);
  const meanX = (normalized.length - 1) / 2;
  const meanY = normalized.reduce((sum, value) => sum + value, 0) / normalized.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    numerator += (index - meanX) * (normalized[index] - meanY);
    denominator += (index - meanX) ** 2;
  }
  return denominator ? Number((numerator / denominator).toFixed(3)) : 0;
}

async function sampleProcessTree({ rootPid, executable, marker = '' }) {
  const safePid = Math.max(0, Number(rootPid) || 0);
  const script = `
$rootPid = ${safePid}
$targetPath = ${powershellLiteral(executable)}
$marker = ${powershellLiteral(marker)}
$all = @(Get-CimInstance Win32_Process)
$ids = New-Object 'System.Collections.Generic.HashSet[int]'
$root = $all | Where-Object { $_.ProcessId -eq $rootPid -and $_.ExecutablePath -eq $targetPath } | Select-Object -First 1
if ($null -ne $root) { [void]$ids.Add([int]$root.ProcessId) }
if ($marker) {
  $all | Where-Object { $_.ExecutablePath -eq $targetPath -and $_.CommandLine -and $_.CommandLine.Contains($marker) } |
    ForEach-Object { [void]$ids.Add([int]$_.ProcessId) }
}
do {
  $added = $false
  foreach ($item in $all) {
    if ($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)) { $added = $true }
  }
} while ($added)
$rows = @()
foreach ($item in $all) {
  if (-not $ids.Contains([int]$item.ProcessId)) { continue }
  $process = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
  if ($null -eq $process) { continue }
  $role = if ($item.CommandLine -match '--type=gpu-process') { 'gpu' } elseif ($item.CommandLine -match '--type=renderer') { 'renderer' } elseif ($item.CommandLine -match '--utility-sub-type=audio') { 'audio' } elseif ($item.CommandLine -match '--type=utility') { 'utility' } else { 'main' }
  $rows += [pscustomobject]@{
    pid = $process.Id
    parentPid = [int]$item.ParentProcessId
    role = $role
    workingSetMB = [math]::Round($process.WorkingSet64 / 1MB, 2)
    privateMB = [math]::Round($process.PrivateMemorySize64 / 1MB, 2)
    cpuSeconds = if ($null -eq $process.CPU) { 0 } else { [math]::Round($process.CPU, 3) }
  }
}
[pscustomobject]@{ processes = @($rows) } | ConvertTo-Json -Depth 4 -Compress
`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024
  });
  const rows = normalizeRows(JSON.parse(stdout.trim()).processes);
  return {
    processCount: rows.length,
    workingSetMB: Number(rows.reduce((sum, row) => sum + (Number(row.workingSetMB) || 0), 0).toFixed(2)),
    privateMB: Number(rows.reduce((sum, row) => sum + (Number(row.privateMB) || 0), 0).toFixed(2)),
    cpuSeconds: Number(rows.reduce((sum, row) => sum + (Number(row.cpuSeconds) || 0), 0).toFixed(3)),
    roles: summarizeByRole(rows),
    processes: rows
  };
}

async function stopProcessTree({ rootPid, executable, marker = '' }) {
  const safePid = Math.max(0, Number(rootPid) || 0);
  if (!safePid && !marker) return;
  const script = `
$rootPid = ${safePid}
$targetPath = ${powershellLiteral(executable)}
$marker = ${powershellLiteral(marker)}
$all = @(Get-CimInstance Win32_Process)
$ids = New-Object 'System.Collections.Generic.HashSet[int]'
$root = $all | Where-Object { $_.ProcessId -eq $rootPid -and $_.ExecutablePath -eq $targetPath } | Select-Object -First 1
if ($null -ne $root) { [void]$ids.Add([int]$root.ProcessId) }
if ($marker) {
  $all | Where-Object { $_.ExecutablePath -eq $targetPath -and $_.CommandLine -and $_.CommandLine.Contains($marker) } |
    ForEach-Object { [void]$ids.Add([int]$_.ProcessId) }
}
do {
  $added = $false
  foreach ($item in $all) {
    if ($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)) { $added = $true }
  }
} while ($added)
$ordered = @($ids | Where-Object { $_ -ne $rootPid }) + @($ids | Where-Object { $_ -eq $rootPid })
foreach ($id in $ordered) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
    windowsHide: true,
    maxBuffer: 1024 * 1024
  }).catch(() => {});
}

module.exports = {
  linearSlope,
  sampleProcessTree,
  stopProcessTree,
  summarizeByRole
};
