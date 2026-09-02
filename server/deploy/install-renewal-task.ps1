$ErrorActionPreference = 'Stop'

$renewalScript = (Resolve-Path (Join-Path $PSScriptRoot 'renew-ip-certificate.ps1')).Path
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument (
  "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$renewalScript`""
)
$triggers = @(
  (New-ScheduledTaskTrigger -Daily -At '12:00'),
  (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME)
)
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
$principal = New-ScheduledTaskPrincipal `
  -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName 'SakuraFall Certificate Renewal' `
  -Description 'Keeps the short-lived SakuraFall HTTPS IP certificate renewed.' `
  -Action $action `
  -Trigger $triggers `
  -Settings $settings `
  -Principal $principal `
  -Force | Out-Null

Write-Host 'Scheduled task installed: SakuraFall Certificate Renewal'
