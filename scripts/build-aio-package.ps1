[CmdletBinding()]
param([string]$RepoRoot = '', [string]$ProfileSeedDir = '', [string]$NodeHome = '', [switch]$Verify, [switch]$Clean, [switch]$FullTest)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$oldPath = $env:PATH; $oldSeed = $env:DSH_PROFILE_SEED_DIR; $oldClean = $env:AIO_CLEAN_BUILD
$steps = [Collections.Generic.List[object]]::new()
$total = [Diagnostics.Stopwatch]::StartNew()
function Invoke-Step([string]$Name, [string]$Command, [string[]]$Arguments) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "==> $Name"
    & $Command @Arguments
    $code = $LASTEXITCODE
    $steps.Add([ordered]@{ name=$Name; elapsedMs=$watch.ElapsedMilliseconds; exitCode=$code })
    if ($code -ne 0) { throw "$Name failed ($code)" }
}
function Assert-Child([string]$Target, [string]$Root) {
    $full = [IO.Path]::GetFullPath($Target)
    if (-not $full.StartsWith([IO.Path]::GetFullPath($Root).TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Build path escaped workspace' }
    $item = Get-Item -LiteralPath $full -Force -ErrorAction SilentlyContinue
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    while ($null -ne $item) {
        if (-not $seen.Add($item.FullName)) { break }
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Build output uses a reparse point' }
        # PSIsContainer is an ETS property that StrictMode rejects on some objects.
        $item = if ($item -is [IO.DirectoryInfo]) { $item.Parent } else { $item.Directory }
    }
}
Push-Location $RepoRoot
try {
    if (-not $NodeHome) {
        $candidate = Join-Path $RepoRoot 'temp\toolchain\node-v24.19.0-win-x64'
        if (Test-Path -LiteralPath (Join-Path $candidate 'node.exe')) { $NodeHome=$candidate }
    }
    if ($NodeHome) { $env:PATH = (Resolve-Path -LiteralPath $NodeHome).Path+';'+$env:PATH }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
    if (-not $ProfileSeedDir) { $ProfileSeedDir=$env:DSH_PROFILE_SEED_DIR }
    if (-not $ProfileSeedDir) { $ProfileSeedDir=Join-Path $RepoRoot 'temp\build-inputs\aio-1.2.0-public-seed' }
    $env:DSH_PROFILE_SEED_DIR=(Resolve-Path -LiteralPath $ProfileSeedDir).Path
    if (-not (Test-Path -LiteralPath (Join-Path $env:DSH_PROFILE_SEED_DIR 'profiles\web-desktop\node_modules'))) { throw 'Incomplete reviewed profile seed' }
    $env:AIO_CLEAN_BUILD = if ($Clean) { '1' } else { '0' }
    foreach ($prefix in @('', 'tauri-app')) {
        $directory=if($prefix){Join-Path $RepoRoot $prefix}else{$RepoRoot}
        & $npm --prefix $directory ls --omit=optional --depth=0 --silent *> $null
        if ($LASTEXITCODE -ne 0) { Invoke-Step "Install $prefix dependencies" $npm @('--prefix',$directory,'ci') }
    }
    if (-not (Test-Path -LiteralPath 'vendor/node/node.exe') -or -not (Test-Path -LiteralPath 'vendor/npm/bin/npm-cli.js')) { Invoke-Step 'Prepare bundled runtime' $npm @('run','fetch-runtime') }
    $version=(Get-Content package.json -Raw -Encoding UTF8 | ConvertFrom-Json).version
    foreach ($file in @('tauri-app/package.json','tauri-app/tauri.conf.json')) {
        if ((Get-Content $file -Raw -Encoding UTF8 | ConvertFrom-Json).version -ne $version) { throw 'Product versions disagree' }
    }
    if ((Get-Content 'tauri-app/Cargo.toml' -Raw) -notmatch ('(?m)^version = "'+[regex]::Escape($version)+'"')) { throw 'Cargo version disagrees' }
    $target=Join-Path $RepoRoot 'tauri-app\target'
    if ($env:CARGO_TARGET_DIR) { $target=[IO.Path]::GetFullPath((Join-Path (Join-Path $RepoRoot 'tauri-app') $env:CARGO_TARGET_DIR)) }
    if ($Clean) { Assert-Child $target $RepoRoot; Invoke-Step 'Clean release compilation' 'cargo' @('clean','--release','--manifest-path','tauri-app/Cargo.toml','--target-dir',$target) }
    if ($FullTest) {
        Invoke-Step 'Prepare test fixtures' $node @('scripts/prepare-test-fixtures.mjs')
        Invoke-Step 'Compile test runtime' $node @('tauri-app/node_modules/typescript/bin/tsc','-p','sidecar/tsconfig.json','--noEmitOnError')
        Invoke-Step 'Full JavaScript tests' $node @('--test','--test-concurrency=1','test/*.test.mjs')
        Invoke-Step 'Rust tests' 'cargo' @('test','--locked','--manifest-path','tauri-app/Cargo.toml')
    }
    Invoke-Step 'Build Tauri/NSIS' $npm @('--prefix','tauri-app','run','bundle')
    $builtSetup=Join-Path $target "release\bundle\nsis\DSHEAC AIO_${version}_x64-setup.exe"
    if (-not (Test-Path -LiteralPath $builtSetup -PathType Leaf)) { throw 'Current-version NSIS output missing' }
    $output=Join-Path $RepoRoot ('temp\package-output-'+[guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path (Join-Path $output 'portable') -Force | Out-Null
    Copy-Item -LiteralPath $builtSetup -Destination (Join-Path $output "DSHEAC-AIO-v$version-Setup-x64.exe")
    Invoke-Step 'Create portable package' $node @('scripts/package-portable.mjs','--target',$target,'--out',(Join-Path $output 'portable'))
    Invoke-Step 'Verify and record artifacts' $node @('scripts/build-provenance.mjs','--out',$output)
    $dist=Join-Path $RepoRoot 'dist'; New-Item -ItemType Directory -Path $dist -Force | Out-Null
    foreach ($entry in Get-ChildItem -LiteralPath $output) {
        $destination=Join-Path $dist $entry.Name
        if (Test-Path -LiteralPath $destination) { Assert-Child $destination $dist; Remove-Item -LiteralPath $destination -Recurse -Force }
        Move-Item -LiteralPath $entry.FullName -Destination $destination
    }
    if ($Verify) { Invoke-Step 'Installer E2E' 'powershell.exe' @('-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/verify-aio-installer.ps1','-ProjectRoot',$RepoRoot) }
    Write-Host "Build complete: $dist"
} finally {
    $metrics=Join-Path $RepoRoot 'temp\build-metrics'; New-Item -ItemType Directory -Path $metrics -Force | Out-Null
    [ordered]@{ totalMs=$total.ElapsedMilliseconds; steps=@($steps.ToArray()) } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $metrics 'build.json') -Encoding UTF8
    $env:PATH=$oldPath; $env:DSH_PROFILE_SEED_DIR=$oldSeed; $env:AIO_CLEAN_BUILD=$oldClean
    Pop-Location
}
