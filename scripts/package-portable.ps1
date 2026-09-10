param([string]$Executable,[string]$Resources,[string]$Output,[string]$Version,[ValidateSet('Fastest','Optimal')][string]$Compression='Fastest')
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path -LiteralPath $Output) { throw 'Portable output already exists' }
$level=[IO.Compression.CompressionLevel]::$Compression
$stream=[IO.File]::Open($Output,[IO.FileMode]::CreateNew)
$zip=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create)
try {
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$Executable,'DSHEAC AIO.exe',$level) | Out-Null
    $marker=$zip.CreateEntry('.dsh-portable'); $writer=[IO.StreamWriter]::new($marker.Open())
    try {$writer.Write("DSHEAC AIO portable v$Version`n")} finally {$writer.Dispose()}
    $resourcesRoot=(Resolve-Path -LiteralPath $Resources).Path.TrimEnd('\')
    foreach ($file in Get-ChildItem -LiteralPath $resourcesRoot -File -Recurse -Force | Sort-Object FullName) {
        if ($file.Name -eq '.gitkeep') { continue }
        if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Portable resource link rejected' }
        $relative='resources/'+$file.FullName.Substring($resourcesRoot.Length+1).Replace('\','/')
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$file.FullName,$relative,$level) | Out-Null
    }
} finally {$zip.Dispose();$stream.Dispose()}
$verify=[IO.Compression.ZipFile]::OpenRead($Output)
try {
    foreach ($name in @('DSHEAC AIO.exe','.dsh-portable','resources/node/node.exe','resources/profile-seed/profiles/web-desktop/package.json')) {
        if (-not $verify.GetEntry($name)) {throw "Portable package missing $name"}
    }
} finally {$verify.Dispose()}
