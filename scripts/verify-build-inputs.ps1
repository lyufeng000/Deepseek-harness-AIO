[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Archive,
    [Parameter(Mandatory = $true)][string]$ChecksumFile,
    [string]$ExtractTo = ''
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

function Invoke-Tar([string[]]$Arguments, [string]$Label) {
    & tar.exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE" }
}

$Archive = (Resolve-Path -LiteralPath $Archive).Path
$ChecksumFile = (Resolve-Path -LiteralPath $ChecksumFile).Path
if ([IO.Path]::GetExtension($Archive) -ne '.zip') { throw "Build input archive must be a .zip file: $Archive" }

$checksumText = Get-Content -LiteralPath $ChecksumFile -Raw -Encoding ASCII
$match = [regex]::Match($checksumText, '(?im)^\s*([0-9a-f]{64})\s+')
if (-not $match.Success) { throw "Invalid SHA-256 file: $ChecksumFile" }
$expected = $match.Groups[1].Value.ToLowerInvariant()
$actual = Get-Sha256Hex $Archive
if ($actual -ne $expected) { throw "SHA-256 mismatch: expected $expected, got $actual" }

$entries = @(& tar.exe -tf $Archive)
foreach ($requiredEntry in @('vendor/node/node.exe', 'vendor/npm/bin/npm-cli.js', 'build-inputs-manifest.json')) {
    if ($entries -notcontains $requiredEntry) { throw "Archive is missing $requiredEntry" }
}
$seedEntry = @($entries | Where-Object { $_ -match '^[^/]+/profiles/web-desktop/node_modules/' } | Select-Object -First 1)
if (-not $seedEntry) { throw 'Archive is missing the profile seed node_modules tree' }

$result = [ordered]@{
    ok = $true
    archive = $Archive
    checksumFile = $ChecksumFile
    sha256 = $actual
    extractedTo = $null
    manifest = $null
}

if (-not [string]::IsNullOrWhiteSpace($ExtractTo)) {
    $ExtractTo = [IO.Path]::GetFullPath($ExtractTo)
    if (Test-Path -LiteralPath $ExtractTo) {
        if (@(Get-ChildItem -LiteralPath $ExtractTo -Force).Count -ne 0) {
            throw "Extraction target must be empty: $ExtractTo"
        }
    } else {
        New-Item -ItemType Directory -Path $ExtractTo -Force | Out-Null
    }
    Invoke-Tar -Label 'Extract build-inputs archive' -Arguments @('-xf', $Archive, '-C', $ExtractTo)
    $manifestPath = Join-Path $ExtractTo 'build-inputs-manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'Extracted manifest is missing' }
    $seedDirectory = (Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json).profileSeed.directory
    foreach ($required in @(
        (Join-Path $ExtractTo 'vendor\node\node.exe'),
        (Join-Path $ExtractTo 'vendor\npm\bin\npm-cli.js'),
        (Join-Path (Join-Path $ExtractTo $seedDirectory) 'profiles\web-desktop\node_modules')
    )) {
        if (-not (Test-Path -LiteralPath $required)) { throw "Extracted build input is missing: $required" }
    }
    $result.extractedTo = $ExtractTo
    $result.manifest = $manifestPath
}

$result | ConvertTo-Json -Depth 5
