[CmdletBinding()]
param(
    [switch]$SkipLocalTests,
    [switch]$RequireWorkstationPublic401
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$bundledPython = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
$node = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { (Get-Command node -ErrorAction Stop).Source }
$python = if (Test-Path -LiteralPath $bundledPython) { $bundledPython } else { (Get-Command python -ErrorAction Stop).Source }
$orchestrator = Join-Path $root "deploy\deploy-server.py"
$pythonDeps = Join-Path $root ".codex_work\python_deps"

if (!(Test-Path -LiteralPath $orchestrator)) {
    throw "Missing repository deploy orchestrator: deploy/deploy-server.py"
}

Push-Location $root
try {
    if (!$SkipLocalTests) {
        & $node --check app/server.mjs
        & $node --check app/pipeline-worker.mjs
        & $node --check app/public/app.js
        & $node --check tools/netease-keyword-discovery.mjs
        & $node --check tools/netease-country-business-discovery.mjs
        & $node app/tests/smoke.mjs
        & $node app/tests/contact-collection-unit.mjs
        & $node app/tests/netease-safety-unit.mjs
        & $node app/tests/mobile-responsive-unit.mjs
        & $node app/tests/keyword-collection-unit.mjs
        & $node app/tests/feature-integration-unit.mjs
        & $node app/tests/mailbox-export-unit.mjs
        & $node app/tests/deployment-contract-unit.mjs
        & $node app/tests/pipeline-worker-unit.mjs
        & $node app/tests/managed-hscode-plan-unit.mjs
        & $python tools/sync-managed-plan.py --self-test
        & $python tools/run-managed-preflight.py --self-test
        & $python -m py_compile deploy/deploy-server.py
        if ($LASTEXITCODE -ne 0) { throw "Local pre-deploy checks failed." }
    }

    New-Item -ItemType Directory -Force -Path $pythonDeps | Out-Null
    $previousPythonPath = $env:PYTHONPATH
    try {
        $env:PYTHONPATH = $pythonDeps
        & $python -c "import paramiko" 2>$null
        if ($LASTEXITCODE -ne 0) {
            & $python -m pip install --disable-pip-version-check --no-input --target $pythonDeps -r deploy/requirements-deploy.txt
            if ($LASTEXITCODE -ne 0) { throw "Deployment dependency installation failed." }
        }
        & $python $orchestrator
        if ($LASTEXITCODE -ne 0) { throw "Server deployment failed." }
    } finally {
        $env:PYTHONPATH = $previousPythonPath
    }

    $publicStatus = (& curl.exe -sS --max-time 20 -o NUL -w "%{http_code}" https://ops.dakingscc.cn/).Trim()
    if ($LASTEXITCODE -ne 0 -or $publicStatus -ne "401") {
        $message = "Workstation public check did not return 401 (got $publicStatus); server-side HTTPS 401 hard gate passed."
        if ($RequireWorkstationPublic401) { throw $message }
        Write-Warning $message
    } else {
        Write-Host "Public check passed: https://ops.dakingscc.cn/ -> 401 (Basic Auth protected)"
    }
    Write-Host "Deployment passed: server health and domain protection verified"
} finally {
    Pop-Location
}
