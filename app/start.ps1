$ErrorActionPreference = "Stop"
$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$systemNode = Get-Command node -ErrorAction SilentlyContinue

if (Test-Path -LiteralPath $bundledNode) {
    $node = $bundledNode
} elseif ($systemNode) {
    $node = $systemNode.Source
} else {
    throw "Node.js runtime not found. Open this project in Codex or install Node.js 20+."
}

& $node (Join-Path $appDir "server.mjs")
