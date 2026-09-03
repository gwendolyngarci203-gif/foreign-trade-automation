param(
  [string]$TaskName = 'DaKings Managed HSCode Plan',
  [string]$DailyAt = '00:05',
  [ValidateRange(15, 180)][int]$RepeatMinutes = 30
)

$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot 'run-managed-hscode-plan.ps1'
if (-not (Test-Path -LiteralPath $runner)) { throw "Managed runner not found: $runner" }

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 3) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$taskCommand = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`""

& schtasks.exe /Create /TN $TaskName /TR $taskCommand /SC MINUTE /MO $RepeatMinutes /ST $DailyAt /IT /RL LIMITED /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Scheduled task trigger registration failed with exit code $LASTEXITCODE" }
Set-ScheduledTask -TaskName $TaskName -Settings $settings -Principal $principal | Out-Null
Get-ScheduledTask -TaskName $TaskName
