param([switch]$Check)

$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $workspace '.codex_work\managed-hscode-logs'
$logPath = Join-Path $logDirectory ((Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null

try {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  $node = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
  if (-not (Test-Path -LiteralPath $node)) { throw "Node.js runtime not found: $node" }
  $runner = Join-Path $workspace 'tools\run-managed-hscode-plan.mjs'
  $bundledPython = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
  $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
  $python = if (Test-Path -LiteralPath $bundledPython) { $bundledPython } elseif ($pythonCommand) { $pythonCommand.Source } else { throw 'Python runtime not found' }
  $sync = Join-Path $workspace 'tools\sync-managed-plan.py'
  $preflight = Join-Path $workspace 'tools\run-managed-preflight.py'
  $runtime = Join-Path $workspace 'tools\start-netease-collection-runtime.ps1'
  $plan = Join-Path $workspace '.codex_work\active-managed-plan.json'
  if (-not (Test-Path -LiteralPath $runner)) { throw "Managed runner not found: $runner" }
  if ($Check) {
    [pscustomobject]@{ ok = $true; node = $node; python = $python; sync = $sync; preflight = $preflight; runner = $runner; plan = $plan; log = $logPath } | ConvertTo-Json -Compress | Tee-Object -FilePath $logPath
    exit 0
  }
  & $python $sync *>&1 | Tee-Object -FilePath $logPath
  if ($LASTEXITCODE -ne 0) { throw "Managed plan sync failed with exit code $LASTEXITCODE" }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $runtime -ServerOnly *>&1 | Tee-Object -FilePath $logPath -Append
  if ($LASTEXITCODE -ne 0) { throw "Local collection service failed with exit code $LASTEXITCODE" }
  & $node $runner $plan --handoff-only *>&1 | Tee-Object -FilePath $logPath -Append
  if ($LASTEXITCODE -ne 0) { throw "Managed handoff check failed with exit code $LASTEXITCODE" }
  & $python $preflight --mode collection *>&1 | Tee-Object -FilePath $logPath -Append
  if ($LASTEXITCODE -eq 2) { Write-Warning 'Managed preflight found a safe stop; no platform action started.'; exit 0 }
  if ($LASTEXITCODE -eq 3) { Write-Host 'Future send inventory is full; NetEase collection is on hold.'; exit 0 }
  if ($LASTEXITCODE -ne 0) { throw "Managed preflight failed with exit code $LASTEXITCODE" }
  & $node $runner $plan *>&1 | Tee-Object -FilePath $logPath -Append
  if ($LASTEXITCODE -ne 0) { throw "Managed HSCode runner failed with exit code $LASTEXITCODE" }
} catch {
  "$(Get-Date -Format o) $($_.Exception.Message)" | Tee-Object -FilePath $logPath -Append | Write-Error
  exit 1
}
