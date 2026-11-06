[CmdletBinding()]
param([string]$Bind = '', [string]$CollectorDirectory = '', [switch]$PassThru, [switch]$Interactive)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This collector setup requires Windows.' }
if ($Interactive -and -not $Bind) {
    Write-Host 'For remote access, enter this model server LAN/Tailscale IP:port (e.g. 100.64.0.10:18761).'
    Write-Host 'Empty keeps the saved address or loopback-only default. No firewall rule is added.'
    $Bind = Read-Host 'Collector bind address'
}
if ($env:BENCH_AGENT_TOKEN) { throw 'This launcher uses a private token file; do not combine it with BENCH_AGENT_TOKEN.' }
if (-not $CollectorDirectory) { $CollectorDirectory = $env:BENCH_COLLECTOR_DIR }
if (-not $CollectorDirectory) {
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is unavailable; specify -CollectorDirectory.' }
    $CollectorDirectory = Join-Path $env:LOCALAPPDATA 'LLM-Bench\collector'
}
$CollectorDirectory = [IO.Path]::GetFullPath($CollectorDirectory)
if ((Test-Path $CollectorDirectory) -and ((Get-Item -LiteralPath $CollectorDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Collector state directory must not be a symbolic link or junction.'
}
$null = New-Item -ItemType Directory -Force -Path $CollectorDirectory
$BenchOwner = [Security.Principal.WindowsIdentity]::GetCurrent().User
$BenchDirectoryAcl = New-Object Security.AccessControl.DirectorySecurity
$BenchDirectoryAcl.SetOwner($BenchOwner)
$BenchDirectoryAcl.SetAccessRuleProtection($true, $false)
$BenchRule = New-Object Security.AccessControl.FileSystemAccessRule($BenchOwner, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
$null = $BenchDirectoryAcl.AddAccessRule($BenchRule)
Set-Acl -LiteralPath $CollectorDirectory -AclObject $BenchDirectoryAcl
$BenchTokenFile = Join-Path $CollectorDirectory 'agent-token.txt'
$BenchBindFile = Join-Path $CollectorDirectory 'bind-address.txt'
$BenchConnectionFile = Join-Path $CollectorDirectory 'collector-connection.json'
foreach ($BenchFile in @($BenchTokenFile, $BenchBindFile, $BenchConnectionFile)) {
    if ((Test-Path $BenchFile) -and ((Get-Item -LiteralPath $BenchFile).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Collector configuration must not be a symbolic link.'
    }
}
if ($env:BENCH_AGENT_TOKEN_FILE -and $env:BENCH_AGENT_TOKEN_FILE -ne $BenchTokenFile) {
    throw 'This launcher manages agent-token.txt in its collector folder. Use the binary directly for a custom token file.'
}
if (-not $Bind) { $Bind = $env:BENCH_AGENT_BIND }
if (-not $Bind -and (Test-Path $BenchBindFile)) { $Bind = [IO.File]::ReadAllText($BenchBindFile).Trim() }
if (-not $Bind) { $Bind = '127.0.0.1:18761' }
if ($Bind -match '^\[(?<address>[0-9a-fA-F:.]+)\]:(?<port>[0-9]+)$' -or $Bind -match '^(?<address>[0-9.]+):(?<port>[0-9]+)$') {
    $BenchAddressText = $Matches['address']; $BenchPort = [int]$Matches['port']
} else { throw 'Bind must be an IP:port, such as 127.0.0.1:18761 or [::1]:18761.' }
$BenchParsedAddress = $null
if (-not [Net.IPAddress]::TryParse($BenchAddressText, [ref]$BenchParsedAddress) -or $BenchPort -lt 1 -or $BenchPort -gt 65535) {
    throw 'Invalid IP address or port.'
}
$BenchUtf8 = New-Object Text.UTF8Encoding($false)
if (-not (Test-Path $BenchTokenFile)) {
    $BenchRandom = [Security.Cryptography.RandomNumberGenerator]::Create()
    $BenchBytes = New-Object byte[] 32
    try { $BenchRandom.GetBytes($BenchBytes) } finally { $BenchRandom.Dispose() }
    $BenchToken = [BitConverter]::ToString($BenchBytes).Replace('-', '').ToLowerInvariant()
    $BenchStream = New-Object IO.FileStream($BenchTokenFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $BenchTokenBytes = $BenchUtf8.GetBytes($BenchToken); $BenchStream.Write($BenchTokenBytes, 0, $BenchTokenBytes.Length) } finally { $BenchStream.Dispose() }
}
$BenchToken = [IO.File]::ReadAllText($BenchTokenFile).Trim()
if ($BenchToken -notmatch '^[A-Za-z0-9._~+/=-]{32,4096}$') { throw 'Existing collector token is invalid. Its value is never printed.' }
$BenchUrl = "http://$Bind/metrics"; $BenchHealthUrl = "http://$Bind/health"
if ($BenchAddressText -in @('0.0.0.0', '::')) { $BenchUrl = $null; $BenchHealthUrl = $null }
$BenchConnection = @{schema_version=1; bind=$Bind; url=$BenchUrl; health_url=$BenchHealthUrl; auth='bearer'; token_file='agent-token.txt'}
[IO.File]::WriteAllText($BenchBindFile, "$Bind`n", $BenchUtf8)
[IO.File]::WriteAllText($BenchConnectionFile, ($BenchConnection | ConvertTo-Json) + "`n", $BenchUtf8)
foreach ($BenchFile in @($BenchTokenFile, $BenchBindFile, $BenchConnectionFile)) {
    $BenchFileAcl = New-Object Security.AccessControl.FileSecurity
    $BenchFileAcl.SetOwner($BenchOwner)
    $BenchFileAcl.SetAccessRuleProtection($true, $false)
    $null = $BenchFileAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($BenchOwner, 'FullControl', 'Allow')))
    Set-Acl -LiteralPath $BenchFile -AclObject $BenchFileAcl
}
Write-Host "Collector prepared. Bind: $Bind"
Write-Host "Connection file: $BenchConnectionFile"
Write-Host 'The secret remains in agent-token.txt. No firewall rule was changed.'
if ($PassThru) { return @{bind=$Bind; token_file=$BenchTokenFile; state_dir=$CollectorDirectory} }
