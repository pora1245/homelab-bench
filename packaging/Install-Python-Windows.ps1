# Opens the official installer page. Does not silently install a runtime.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Write-Host 'Python is needed once for math and instruction-following graders.'
Write-Host 'Install the official Python 3.14 Windows 64-bit installer for the current user.'
Write-Host 'No Docker, VM, global execution-policy change or silent installation is performed.'
Start-Process 'https://www.python.org/downloads/release/python-31410/'
$null = Read-Host 'Press Enter after installation, or press Enter now to use built-in packs first'
