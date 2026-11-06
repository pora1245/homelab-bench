# One-time non-code setup; opens the official Python helper only when missing.
[CmdletBinding()]
param([string]$Python = '', [string]$DataDirectory = '')
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This setup requires Windows.' }
$BenchAppDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $BenchAppDirectory
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
if ($DataDirectory) { $env:BENCH_DATA_DIR = [IO.Path]::GetFullPath($DataDirectory) }
if (-not $env:BENCH_DATA_DIR) {
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is unavailable; specify -DataDirectory.' }
    $env:BENCH_DATA_DIR = Join-Path $env:LOCALAPPDATA 'LLM-Bench\data'
}
if (-not $env:NLTK_DATA) { $env:NLTK_DATA = Join-Path $env:BENCH_DATA_DIR 'nltk_data' }
function Find-BenchPython {
    $BenchCandidates = @($Python, (Join-Path $BenchAppDirectory '.venv\Scripts\python.exe'))
    if ($env:LOCALAPPDATA) {
        foreach ($BenchVersion in @('314', '313', '312', '311')) {
            $BenchCandidates += Join-Path $env:LOCALAPPDATA "Programs\Python\Python$BenchVersion\python.exe"
        }
    }
    $BenchCommand = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($BenchCommand -and $BenchCommand.Source -notmatch 'WindowsApps') { $BenchCandidates += $BenchCommand.Source }
    foreach ($BenchCandidate in $BenchCandidates) {
        if (-not $BenchCandidate -or -not (Get-Command $BenchCandidate -ErrorAction SilentlyContinue)) { continue }
        try {
            $BenchFound = & $BenchCandidate -c 'import sys; assert sys.version_info >= (3,11); print(sys.executable)' 2>$null
            if ($LASTEXITCODE -eq 0) { return [string]($BenchFound | Select-Object -Last 1) }
        } catch { continue }
    }
    $BenchPyLauncher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($BenchPyLauncher) {
        # Query installed paths only; requesting an absent version could make
        # a Python install manager download it without this helper's UI step.
        try { $BenchInstalled = & $BenchPyLauncher.Source -0p 2>$null } catch { $BenchInstalled = @() }
        foreach ($BenchLine in $BenchInstalled) {
            if ($BenchLine -match '(?i)([A-Z]:\\.+python(?:3)?\.exe)\s*$') {
                try {
                    $BenchInstalledPython = $Matches[1]
                    $BenchFound = & $BenchInstalledPython -c 'import sys; assert sys.version_info >= (3,11); print(sys.executable)' 2>$null
                    if ($LASTEXITCODE -eq 0) { return [string]($BenchFound | Select-Object -Last 1) }
                } catch { continue }
            }
        }
    }
    return $null
}
$BenchPython = Find-BenchPython
if (-not $BenchPython) {
    & (Join-Path $PSScriptRoot 'Install-Python-Windows.ps1')
    $BenchPython = Find-BenchPython
}
if (-not $BenchPython) { throw 'Python is not ready. Built-in packs remain available; retry setup after installation.' }
& $BenchPython tools/prepare_graders.py --data-dir $env:BENCH_DATA_DIR
if ($LASTEXITCODE -ne 0) { throw 'Non-code grader setup failed. Review the output and retry.' }
Write-Host 'Non-code graders are ready. Optional code grading has a separate Setup-Code-Grader-Windows.ps1 helper.'
