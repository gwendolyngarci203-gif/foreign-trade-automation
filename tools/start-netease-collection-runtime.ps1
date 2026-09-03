param(
    [switch]$SkipPageValidation,
    [switch]$ServerOnly
)

$ErrorActionPreference = "Stop"

$workspace = Split-Path -Parent $PSScriptRoot
$node = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$serverDir = Join-Path $workspace "app"
$serverScript = Join-Path $serverDir "server.mjs"
$stdout = Join-Path $serverDir ".server-4174.stdout.log"
$stderr = Join-Path $serverDir ".server-4174.stderr.log"
$runtimeFiles = @(
    $serverScript,
    (Join-Path $serverDir "contact-collection.mjs"),
    (Join-Path $serverDir "data\email-template-library.json")
)

if (-not (Test-Path -LiteralPath $node)) {
    throw "Bundled Node.js runtime not found: $node"
}

$listener = Get-NetTCPConnection -LocalPort 4174 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
    $owned = $process.ExecutablePath -eq $node -and $process.CommandLine -match 'server\.mjs'
    if (-not $owned) { throw "Port 4174 is owned by an unexpected process: $($process.Name) ($($process.ProcessId))" }
    $latestRuntimeWrite = ($runtimeFiles | Get-Item | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1).LastWriteTimeUtc
    if ($latestRuntimeWrite -gt $process.CreationDate.ToUniversalTime()) {
        Stop-Process -Id $process.ProcessId -Force
        $deadline = (Get-Date).AddSeconds(10)
        do {
            Start-Sleep -Milliseconds 250
            $listener = Get-NetTCPConnection -LocalPort 4174 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        } while ($listener -and (Get-Date) -lt $deadline)
        if ($listener) { throw "Stale local collection service did not stop on port 4174" }
    }
}

$portOpen = [bool](Get-NetTCPConnection -LocalPort 4174 -State Listen -ErrorAction SilentlyContinue)
if (-not $portOpen) {
    $previousPort = $env:PORT
    $env:PORT = "4174"
    try {
        Start-Process -FilePath $node -ArgumentList $serverScript -WorkingDirectory $serverDir `
            -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden | Out-Null
    } finally {
        $env:PORT = $previousPort
    }

    $deadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 500
        $portOpen = [bool](Get-NetTCPConnection -LocalPort 4174 -State Listen -ErrorAction SilentlyContinue)
    } while (-not $portOpen -and (Get-Date) -lt $deadline)
    if (-not $portOpen) {
        throw "Local collection service did not start on port 4174"
    }
}

$health = Invoke-RestMethod -Uri "http://127.0.0.1:4174/api/health" -TimeoutSec 10
if (-not $health.ok -or -not $health.sourceLoaded) { throw "Local collection service health check failed" }
if ($ServerOnly) {
    [pscustomobject]@{ collectionService = "http://127.0.0.1:4174"; ready = $true } | ConvertTo-Json
    exit 0
}

& (Join-Path $PSScriptRoot "start-netease-edge-cdp.ps1")

if ($SkipPageValidation) { exit 0 }

$client = Join-Path $PSScriptRoot "netease-cdp-client.mjs"
$inspection = ""
$deadline = (Get-Date).AddSeconds(90)
$recovered = $false
do {
    $inspection = & $node $client inspect 2>&1
    if ($LASTEXITCODE -eq 0) { break }
    if (-not $recovered) {
        & $node $client ensure-business-page 2>&1 | Out-Null
        $recovered = $true
    }
    Start-Sleep -Seconds 2
} while ((Get-Date) -lt $deadline)
if ($LASTEXITCODE -ne 0) {
    throw "Edge CDP connected, but NetEase fixed elements did not become ready within 90 seconds:`n$inspection"
}

& $node $client dedupe-ready | Out-Null

[pscustomobject]@{
    collectionService = "http://127.0.0.1:4174"
    edgeCdp = "http://127.0.0.1:9223"
    validation = "fixed_elements"
    ready = $true
} | ConvertTo-Json
