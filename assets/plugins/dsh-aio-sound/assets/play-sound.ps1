<#
play-sound.ps1 — play one WAV at a controlled volume, then exit.

Why host-side playback: the browser autoplay policy blocks audio.play()
without a user gesture, and the conversation-complete sound must fire even
when the page was never clicked.

Volume: System.Media.SoundPlayer has no volume control, so the primary path
is the WPF MediaPlayer (PresentationCore), whose Volume is a 0..1 gain that
only affects this playback. It falls back to SoundPlayer (full volume) when
the media stack cannot start (missing codec, headless session, ...).

usage:
  powershell -NoProfile -ExecutionPolicy Bypass -STA -File play-sound.ps1
      -Path <file.wav> [-Volume 0..100]
exit codes: 0 played (or fallback played), 2 file missing, 3 both paths failed.
#>
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [int]$Volume = 100
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Path)) { exit 2 }
$gain = [double]([Math]::Min(100, [Math]::Max(0, $Volume))) / 100.0

try {
  Add-Type -AssemblyName PresentationCore -ErrorAction Stop
  $player = New-Object System.Windows.Media.MediaPlayer
  $player.Open([uri]$Path)
  $player.Volume = $gain
  $player.Play()

  # Wait for the media to open (NaturalDuration available) or give up.
  $deadline = (Get-Date).AddSeconds(10)
  while (-not $player.NaturalDuration.HasTimeSpan -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 20
  }
  if ($player.NaturalDuration.HasTimeSpan) {
    $ms = [int]$player.NaturalDuration.TimeSpan.TotalMilliseconds + 250
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($clock.ElapsedMilliseconds -lt $ms -and (Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 25
    }
    if ($player.Position.TotalMilliseconds -le 0) { throw 'MediaPlayer did not advance (no audio session)' }
    $player.Stop()
    $player.Close()
    exit 0
  }
  throw 'MediaPlayer could not open the file'
} catch {
  try {
    Add-Type -AssemblyName System.Media -ErrorAction Stop
    $fallback = New-Object System.Media.SoundPlayer $Path
    $fallback.PlaySync()
    exit 0
  } catch {
    exit 3
  }
}
