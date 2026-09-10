[CmdletBinding()]
param([string]$RepoRoot = '', [string]$ProfileSeedDir = '', [string]$NodeHome = '', [switch]$Clean, [switch]$Verify)
& (Join-Path $PSScriptRoot 'build-aio-package.ps1') @PSBoundParameters -FullTest
if (-not $?) { exit 1 }
