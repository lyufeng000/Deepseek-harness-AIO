[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [string]$ProfileSeedDir = '',
    [string]$OutputDir = '',
    [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-Sha256Hex([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        $sha = [Security.Cryptography.SHA256]::Create()
        try { return (($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) -join '') }
        finally { $sha.Dispose() }
    } finally { $stream.Dispose() }
}

function Get-TreeStats([string]$Path) {
    $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force)
    [ordered]@{
        files = $files.Count
        bytes = [int64](($files | Measure-Object -Property Length -Sum).Sum)
    }
}

function Invoke-Tar([string[]]$Arguments, [string]$Label) {
    & tar.exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE" }
}

if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$package = Get-Content -LiteralPath (Join-Path $RepoRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($Version)) { $Version = [string]$package.version }
if ([string]::IsNullOrWhiteSpace($ProfileSeedDir)) {
    $ProfileSeedDir = Join-Path $RepoRoot "temp\build-inputs\aio-$Version-public-seed"
}
$ProfileSeedDir = (Resolve-Path -LiteralPath $ProfileSeedDir).Path
if ([string]::IsNullOrWhiteSpace($OutputDir)) { $OutputDir = Join-Path $RepoRoot 'dist\build-inputs' }
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

$vendorNode = Join-Path $RepoRoot 'vendor\node'
$vendorNpm = Join-Path $RepoRoot 'vendor\npm'
foreach ($required in @(
    (Join-Path $vendorNode 'node.exe'),
    (Join-Path $vendorNpm 'bin\npm-cli.js'),
    (Join-Path $ProfileSeedDir 'profiles\web-desktop\node_modules')
)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Required build input is missing: $required" }
}

$seedName = Split-Path -Leaf $ProfileSeedDir
$archiveName = "DSHEAC-AIO-build-inputs-v$Version.zip"
$archivePath = Join-Path $OutputDir $archiveName
$archiveTemp = Join-Path $OutputDir ($archiveName + '.tmp.zip')
$checksumPath = Join-Path $OutputDir ($archiveName + '.sha256')
$manifestName = 'build-inputs-manifest.json'
$manifestPath = Join-Path $OutputDir $manifestName
foreach ($path in @($archiveTemp, $archivePath, $checksumPath, $manifestPath)) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
}

$seedStats = Get-TreeStats $ProfileSeedDir
$manifest = [ordered]@{
    schemaVersion = 1
    productName = 'DSHEAC AIO'
    version = $Version
    createdAtUtc = [DateTime]::UtcNow.ToString('o')
    archive = $archiveName
    profileSeed = [ordered]@{ directory = $seedName; files = $seedStats.files; bytes = $seedStats.bytes }
    vendor = [ordered]@{
        node = Get-TreeStats $vendorNode
        npm = Get-TreeStats $vendorNpm
    }
}
[IO.File]::WriteAllText($manifestPath, (($manifest | ConvertTo-Json -Depth 5) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))

Invoke-Tar -Label 'Create build-inputs archive' -Arguments @(
    '-a', '-c', '-f', $archiveTemp,
    '-C', $RepoRoot, 'vendor/node', 'vendor/npm',
    '-C', (Split-Path -Parent $ProfileSeedDir), $seedName,
    '-C', $OutputDir, $manifestName
)

$sha256 = Get-Sha256Hex $archiveTemp
Move-Item -LiteralPath $archiveTemp -Destination $archivePath -Force
[IO.File]::WriteAllText($checksumPath, ($sha256 + '  ' + $archiveName + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))

$entries = @(& tar.exe -tf $archivePath)
foreach ($requiredEntry in @('vendor/node/node.exe', 'vendor/npm/bin/npm-cli.js', $manifestName)) {
    if ($entries -notcontains $requiredEntry) { throw "Archive is missing $requiredEntry" }
}
if (-not ($entries | Where-Object { $_ -like "$seedName/profiles/web-desktop/node_modules/*" })) {
    throw 'Archive is missing the profile seed node_modules tree'
}

[ordered]@{
    ok = $true
    archive = $archivePath
    checksum = $checksumPath
    manifest = $manifestPath
    sha256 = $sha256
    bytes = (Get-Item -LiteralPath $archivePath).Length
} | ConvertTo-Json -Depth 4
