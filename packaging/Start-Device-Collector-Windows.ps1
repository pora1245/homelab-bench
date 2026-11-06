[CmdletBinding()]
param([string]$Bind = '', [string]$CollectorDirectory = '')
$ErrorActionPreference = 'Stop'
$BenchAppDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not (Test-Path (Join-Path $BenchAppDirectory 'bin\llm-bench.exe'))) { $BenchAppDirectory = $PSScriptRoot }
$BenchExecutable = Join-Path $BenchAppDirectory 'bin\llm-bench.exe'
if (-not (Test-Path $BenchExecutable -PathType Leaf)) { throw 'The matching Windows collector executable is missing.' }
$BenchCollector = & (Join-Path $PSScriptRoot 'Setup-Device-Collector-Windows.ps1') -Bind $Bind -CollectorDirectory $CollectorDirectory -PassThru
$env:BENCH_AGENT_BIND = $BenchCollector.bind
$env:BENCH_AGENT_TOKEN_FILE = $BenchCollector.token_file
Write-Host 'Read-only collector starting. Control-C stops it. The model server is not changed.'
& $BenchExecutable agent
if ($LASTEXITCODE -ne 0) { throw "Collector exited with code $LASTEXITCODE." }
