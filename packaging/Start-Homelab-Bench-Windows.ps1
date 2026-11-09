# Native Windows launcher; no service installation or automatic model requests.
[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)][int]$Port = 18760,
    [string]$DataDirectory = '',
    [switch]$SkipSetup,
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This launcher requires Windows.' }
$BenchAppDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $BenchAppDirectory
$BenchExecutable = Join-Path $BenchAppDirectory 'bin\llm-bench.exe'
if (-not (Test-Path $BenchExecutable -PathType Leaf) -or -not (Test-Path 'web\dist\index.html')) {
    throw 'The Windows executable or UI is missing. Extract the complete Windows package.'
}
if ($DataDirectory) { $env:BENCH_DATA_DIR = [IO.Path]::GetFullPath($DataDirectory) }
if (-not $env:BENCH_DATA_DIR) {
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is unavailable; specify -DataDirectory.' }
    $env:BENCH_DATA_DIR = Join-Path $env:LOCALAPPDATA 'LLM-Bench\data'
}
$null = New-Item -ItemType Directory -Force -Path $env:BENCH_DATA_DIR
$env:BENCH_PORT = [string]$Port
if (-not $env:BENCH_PYTHON) { $env:BENCH_PYTHON = Join-Path $BenchAppDirectory '.venv\Scripts\python.exe' }
if (-not $env:BENCH_CODE_IMAGE) { $env:BENCH_CODE_IMAGE = 'llm-bench-code:py311' }
if (-not $env:BENCH_LCB_IMAGE) { $env:BENCH_LCB_IMAGE = 'llm-bench-code:py311' }
if (-not $env:NLTK_DATA) { $env:NLTK_DATA = Join-Path $env:BENCH_DATA_DIR 'nltk_data' }
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
try {
    $BenchHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
    if ($BenchHealth.ok -and $BenchHealth.version) {
        if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$Port" }
        Write-Host 'An existing Homelab Bench instance is already running. No second process was started.'
        return
    }
} catch { }
if (-not $SkipSetup) {
    try { & (Join-Path $PSScriptRoot 'Setup-Graders-Windows.ps1') -DataDirectory $env:BENCH_DATA_DIR }
    catch { Write-Warning "Some graders are not ready. The app will open with built-in packs available. $($_.Exception.Message)" }
}
Write-Host "Homelab Bench: http://127.0.0.1:$Port"
Write-Host "Records: $env:BENCH_DATA_DIR"
Write-Host 'Keep this terminal open. Control-C stops this instance.'
$BenchBrowserJob = $null
if (-not $NoBrowser) {
    $BenchBrowserJob = Start-Job -ArgumentList $Port -ScriptBlock {
        param($BenchPort)
        for ($BenchAttempt = 0; $BenchAttempt -lt 30; $BenchAttempt++) {
            try {
                $BenchHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$BenchPort/api/health" -TimeoutSec 1
                if ($BenchHealth.ok) { Start-Process "http://127.0.0.1:$BenchPort"; break }
            } catch { }
            Start-Sleep -Seconds 1
        }
    }
}
try {
    & $BenchExecutable
    if ($LASTEXITCODE -ne 0) { throw "Homelab Bench exited with code $LASTEXITCODE." }
} finally {
    if ($BenchBrowserJob) { Stop-Job $BenchBrowserJob -ErrorAction SilentlyContinue; Remove-Job $BenchBrowserJob -Force -ErrorAction SilentlyContinue }
}
