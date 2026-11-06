# Optional existing Docker Linux-container backend only; no VM installation.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$BenchAppDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) {
    throw 'Optional code grading needs an existing Docker installation. Non-code tests do not need Docker.'
}
$BenchDockerOS = & docker.exe info --format '{{.OSType}}'
if ($LASTEXITCODE -ne 0 -or $BenchDockerOS -ne 'linux') { throw 'Start the existing Docker Linux-container environment first.' }
$BenchBuildDir = Join-Path ([IO.Path]::GetTempPath()) ('llm-bench-code-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $BenchBuildDir
try {
    Copy-Item (Join-Path $BenchAppDirectory 'scorers\Dockerfile') (Join-Path $BenchBuildDir 'Dockerfile')
    & docker.exe build -t llm-bench-code:py311 $BenchBuildDir
    if ($LASTEXITCODE -ne 0) { throw 'Code grader image preparation failed.' }
} finally { Remove-Item -LiteralPath $BenchBuildDir -Recurse -Force }
Write-Host 'Optional code grader prepared. Recheck readiness in the app.'
