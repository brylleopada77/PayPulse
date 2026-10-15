# Starts PayPulse on this PC and shares it with a temporary public link.
#
#   1. Database  - local PostgreSQL in %LOCALAPPDATA%\PayPulse-Postgres
#   2. App       - node src/server.js on http://localhost:3000   (log: logs\app.log)
#   3. Tunnel    - Cloudflare quick tunnel = the public link      (log: logs\tunnel.log)
#
# All three run hidden in the background, not inside any window, so closing windows
# (or Claude Code / VS Code) does not stop them. Use stop-paypulse.cmd to stop everything.
# Double-click start-paypulse.cmd to run this. The public link changes every time the tunnel starts.

param(
  [switch]$NoBrowser,  # don't open the link in the browser
  [switch]$NoPause     # don't wait for Enter at the end (for automation)
)

# 'Continue': in Windows PowerShell 5.1, 'Stop' turns a program's stderr output into a crash.
# Every step checks its own result and calls Fail instead.
$ErrorActionPreference = 'Continue'
$Host.UI.RawUI.WindowTitle = 'PayPulse Launcher'

$root        = $PSScriptRoot
$pgDir       = Join-Path $env:LOCALAPPDATA 'PayPulse-Postgres'
$pgCtl       = Join-Path $pgDir 'bin\pg_ctl.exe'
$pgData      = Join-Path $pgDir 'data'
$pgLog       = Join-Path $pgDir 'postgres.log'
$cloudflared = Join-Path $env:LOCALAPPDATA 'cloudflared\cloudflared.exe'
$logDir      = Join-Path $root 'logs'
$appLog      = Join-Path $logDir 'app.log'
$tunnelLog   = Join-Path $logDir 'tunnel.log'
$linkFile    = Join-Path $root 'paypulse-link.txt'
$localUrl    = 'http://localhost:3000'
$linkPattern = 'https://[a-z0-9-]+\.trycloudflare\.com'

function Step($text)    { Write-Host "`n>> $text" -ForegroundColor Cyan }
function Ok($text)      { Write-Host "   OK  $text" -ForegroundColor Green }
function Warn($text)    { Write-Host "   !!  $text" -ForegroundColor Yellow }
function Finish($code) {
  if (-not $NoPause) { Read-Host "`nPress Enter to close this window" | Out-Null }
  exit $code
}
function Fail($text) {
  Write-Host "`n   FAILED: $text" -ForegroundColor Red
  Finish 1
}

function Test-Health($url) {
  try { return (Invoke-RestMethod "$url/health" -TimeoutSec 8).status -eq 'ok' } catch { return $false }
}

function Wait-Until($seconds, [scriptblock]$check) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (& $check) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

# Starts a hidden background program through WMI. It is not attached to this window
# (or any other window), so it keeps running when windows are closed.
function Start-Background($commandLine) {
  $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
  $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine               = $commandLine
    CurrentDirectory          = $root
    ProcessStartupInformation = $startup
  }
  if ($result.ReturnValue -ne 0) { Fail "could not start: $commandLine (error $($result.ReturnValue))" }
}

function Get-TunnelLink {
  if (-not (Test-Path $tunnelLog)) { return $null }
  $m = Select-String -Path $tunnelLog -Pattern $linkPattern | Select-Object -Last 1
  if ($m) { return $m.Matches[0].Value }
  return $null
}

Write-Host '==============================================' -ForegroundColor Magenta
Write-Host '            Starting PayPulse ...' -ForegroundColor Magenta
Write-Host '==============================================' -ForegroundColor Magenta

# ---------- Checks ----------
if (-not (Test-Path $pgCtl))       { Fail "PostgreSQL not found in $pgDir" }
if (-not (Test-Path $cloudflared)) { Fail "cloudflared not found at $cloudflared" }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Fail 'Node.js is not installed or not on PATH' }
if (-not (Test-Path (Join-Path $root '.env'))) { Fail "Missing .env in $root (copy .env.example to .env)" }
if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Step 'Installing packages (first run only)'
  Push-Location $root; npm install; Pop-Location
}
New-Item -ItemType Directory -Force $logDir | Out-Null

# ---------- 1. Database ----------
Step '1/3  Database'
& $pgCtl -D $pgData status *> $null
if ($LASTEXITCODE -eq 0) {
  Ok 'already running'
} else {
  # Not "& pg_ctl ... *> $null": the database server inherits that output pipe and keeps it open,
  # so PowerShell would wait forever. Start pg_ctl separately and wait only for pg_ctl itself.
  $ctl = Start-Process -FilePath $pgCtl -WindowStyle Hidden -PassThru `
    -ArgumentList @('-D', "`"$pgData`"", '-l', "`"$pgLog`"", '-o', '"-p 5432 -c listen_addresses=localhost"', '-w', 'start')
  $null = $ctl.Handle   # lets ExitCode be read after the process ends (Windows PowerShell quirk)
  $ctl.WaitForExit()
  if ($ctl.ExitCode -ne 0) { Fail "could not start PostgreSQL (see $pgLog)" }
  Ok 'started'
}
Push-Location $root
node scripts/init-db.js *> $null
$initOk = $LASTEXITCODE -eq 0
Pop-Location
if (-not $initOk) { Fail 'could not prepare the database tables (run: npm run db:init)' }
Ok 'tables ready'

# ---------- 2. App ----------
Step '2/3  App'
if (Test-Health $localUrl) {
  Ok "already running at $localUrl"
} else {
  # cmd.exe is only there to write the app's output to logs\app.log.
  Start-Background "cmd.exe /c `"`"$node`" src\server.js > `"$appLog`" 2>&1`""
  if (-not (Wait-Until 40 { Test-Health $localUrl })) { Fail "the app did not start (see $appLog)" }
  Ok "running at $localUrl  (in the background)"
}

# ---------- 3. Public link ----------
Step '3/3  Public link'
$running = Get-Process cloudflared -ErrorAction SilentlyContinue
$url = if ($running) { Get-TunnelLink } else { $null }

if ($url -and (Test-Health $url)) {
  Ok 'tunnel already running'
} else {
  if ($running) { $running | Stop-Process -Force }   # stale tunnel without a working link
  Remove-Item $tunnelLog -ErrorAction SilentlyContinue
  Start-Background "`"$cloudflared`" tunnel --no-autoupdate --url $localUrl --logfile `"$tunnelLog`""

  $found = Wait-Until 60 { $script:url = Get-TunnelLink; [bool]$script:url }
  if (-not $found) { Fail "no public link from Cloudflare (see $tunnelLog)" }

  Write-Host '   ..  waiting for the new link to come online (up to a minute)'
  Start-Sleep -Seconds 8   # asking too early can make Windows remember "site not found" for a while
  $online = Wait-Until 60 {
    if (Test-Health $script:url) { return $true }
    ipconfig /flushdns *> $null
    Start-Sleep -Seconds 2
    return $false
  }
  if (-not $online) { Warn 'the link is not answering yet; give it another minute, then open it' }
  else { Ok 'online' }
}

Set-Content -Path $linkFile -Value $url -Encoding ascii
try { Set-Clipboard -Value $url; $copied = $true } catch { $copied = $false }

Write-Host ''
Write-Host '==============================================' -ForegroundColor Green
Write-Host '  PayPulse is running. Share this link:' -ForegroundColor Green
Write-Host ''
Write-Host "  $url" -ForegroundColor White
Write-Host ''
if ($copied) { Write-Host '  (copied to the clipboard; also saved in paypulse-link.txt)' -ForegroundColor Green }
else         { Write-Host '  (saved in paypulse-link.txt)' -ForegroundColor Green }
Write-Host '==============================================' -ForegroundColor Green
Write-Host ''
Write-Host 'PayPulse runs in the background: you can close this window.'
Write-Host 'It stops if this PC sleeps, shuts down or restarts. Run start-paypulse.cmd again'
Write-Host 'afterwards (the link will be different). To stop everything: stop-paypulse.cmd'

if (-not $NoBrowser) { Start-Process $url }
Finish 0
