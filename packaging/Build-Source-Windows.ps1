# Native build using an already installed Rust toolchain and its C linker.
# A prebuilt Windows executable does not require this script or Rust/Node.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This builder requires Windows.' }
$BenchAppDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $BenchAppDirectory
foreach ($BenchTool in @('cargo.exe', 'rustc.exe', 'node.exe', 'npm.cmd')) {
    if (-not (Get-Command $BenchTool -ErrorAction SilentlyContinue)) {
        throw "Missing build tool: $BenchTool. See docs/WINDOWS-NATIVE-PREPARATION.md."
    }
}
Push-Location web
try {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'UI build failed.' }
} finally { Pop-Location }
& cargo.exe build --release --locked
if ($LASTEXITCODE -ne 0) { throw 'Rust build failed; check the configured MSVC or MinGW linker.' }
$null = New-Item -ItemType Directory -Force -Path bin
Copy-Item 'target\release\llm-bench.exe' 'bin\llm-bench.exe' -Force
Write-Host 'Build complete. Run packaging\Start-LLM-Bench-Windows.ps1.'
