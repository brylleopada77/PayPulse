@echo off
rem Double-click: PayPulse starts by itself when you log in to Windows and is checked every 10 minutes.
rem To turn it off again:  paypulse-autostart.cmd remove
cd /d "%~dp0"
if /i "%1"=="remove" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0paypulse-autostart.ps1" -Remove
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0paypulse-autostart.ps1"
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-paypulse.ps1" -NoPause -NoBrowser
)
pause
