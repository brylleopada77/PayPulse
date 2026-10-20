# Stops everything start-paypulse.ps1 started: public link, app and database.
# Double-click stop-paypulse.cmd to run it.

param([switch]$NoPause)

$Host.UI.RawUI.WindowTitle = 'PayPulse - Stop'
$pgDir  = Join-Path $env:LOCALAPPDATA 'PayPulse-Postgres'
$pgCtl  = Join-Path $pgDir 'bin\pg_ctl.exe'
$pgData = Join-Path $pgDir 'data'

Write-Host 'Stopping PayPulse ...' -ForegroundColor Magenta

# 1. Public link
$tunnel = Get-Process cloudflared -ErrorAction SilentlyContinue
if ($tunnel) { $tunnel | Stop-Process -Force; Write-Host '   OK  public link stopped' -ForegroundColor Green }
else { Write-Host '   --  public link was not running' }

# 2. App (whatever is listening on port 3000)
$appPids = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique
if ($appPids) {
  $appPids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
  Write-Host '   OK  app stopped' -ForegroundColor Green
} else { Write-Host '   --  app was not running' }

# 3. Database (clean shutdown, data is kept)
if (Test-Path $pgCtl) {
  & $pgCtl -D $pgData status *> $null
  if ($LASTEXITCODE -eq 0) {
    & $pgCtl -D $pgData -m fast stop *> $null
    Write-Host '   OK  database stopped (your data is kept)' -ForegroundColor Green
  } else { Write-Host '   --  database was not running' }
}

Write-Host "`nPayPulse is stopped. Nothing is left running."
if (-not $NoPause) { Read-Host "`nPress Enter to close this window" | Out-Null }
