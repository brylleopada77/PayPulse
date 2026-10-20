@echo off
rem Double-click to stop PayPulse (public link, app and database).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-paypulse.ps1" %*
