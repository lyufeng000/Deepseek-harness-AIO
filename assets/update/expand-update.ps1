param([Parameter(Mandatory)][string]$Archive, [Parameter(Mandatory)][string]$Destination, [Parameter(Mandatory)][string]$Version)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path -LiteralPath $Destination) { throw 'Update staging already exists' }
$root = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
$zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    [long]$total = 0
    foreach ($entry in $zip.Entries) {
        $name = $entry.FullName.Replace('\', '/'); while ($name.StartsWith('./')) { $name = $name.Substring(2) }
        if ($name -eq '' -or $name -eq '.') { continue }
        if ($name -match '(^/|:|(^|/)\.\.(/|$)|[. ](/|$))') { throw 'Unsafe archive path' }
        if ($name -notmatch '^(resources/|DSHEAC AIO\.exe$|\.dsh-portable$)') { throw 'Unexpected portable entry' }
        $mode = ($entry.ExternalAttributes -shr 16) -band 0xF000
        if ($mode -eq 0xA000 -or ($entry.ExternalAttributes -band 0x400) -ne 0) { throw 'Archive link rejected' }
        $target = [IO.Path]::GetFullPath((Join-Path $root $name))
        if (-not $target.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escape' }
        if (-not $seen.Add($target.TrimEnd('\'))) { throw 'Duplicate archive entry' }
        $total += $entry.Length
        if ($total -gt 4GB -or $zip.Entries.Count -gt 200000) { throw 'Archive exceeds extraction limits' }
    }
    $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($root))
    if ($drive.AvailableFreeSpace -lt $total + 256MB) { throw 'Insufficient free disk space' }
    New-Item -ItemType Directory -Path $root | Out-Null
    foreach ($entry in $zip.Entries) {
        $name = $entry.FullName.Replace('\', '/'); while ($name.StartsWith('./')) { $name = $name.Substring(2) }
        if ($name -eq '' -or $name -eq '.') { continue }
        $target = Join-Path $root $name
        if ($name.EndsWith('/')) { New-Item -ItemType Directory -Path $target -Force | Out-Null; continue }
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
    }
} finally { $zip.Dispose() }
foreach ($file in @('DSHEAC AIO.exe', '.dsh-portable', 'resources/node/node.exe', 'resources/app/package.json', 'resources/profile-seed/profiles/web-desktop/package.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $file) -PathType Leaf)) { throw 'Incomplete portable update' }
}
$package = Get-Content -LiteralPath (Join-Path $root 'resources/app/package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($package.version -ne $Version -or $package.name -ne 'dsh-desktop-aio') { throw 'Portable identity mismatch' }
