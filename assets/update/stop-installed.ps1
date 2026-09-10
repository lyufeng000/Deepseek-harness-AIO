param([switch]$CheckOnly)
$ErrorActionPreference='Stop'
try {
    if (-not $env:AIO_TARGET_ROOT) { throw 'Missing installation root' }
    $root=[IO.Path]::GetFullPath($env:AIO_TARGET_ROOT).TrimEnd('\')
    if ($root -eq [IO.Path]::GetPathRoot($root).TrimEnd('\')) { throw 'Invalid installation root' }
    $exe=Join-Path $root 'DSHEAC AIO.exe'
    $processes=@(Get-CimInstance Win32_Process -Filter "Name='DSHEAC AIO.exe'")
    # An uninspectable same-name process cannot safely be classified.
    if (@($processes | Where-Object { -not $_.ExecutablePath }).Count) { throw 'Unable to inspect process image' }
    $targets=@($processes | Where-Object { [string]::Equals($_.ExecutablePath,$exe,[StringComparison]::OrdinalIgnoreCase) })
    if ($CheckOnly) { if ($targets.Count) {exit 1}; exit 0 }
    foreach ($target in $targets) {
        & taskkill.exe /PID $target.ProcessId /T /F | Out-Null
        if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $target.ProcessId -ErrorAction SilentlyContinue)) { throw 'Process did not exit' }
    }
    exit 0
} catch { exit 2 }
