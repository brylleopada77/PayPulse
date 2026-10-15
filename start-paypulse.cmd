@echo off
rem Double-click to start PayPulse (database, app and public link).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-paypulse.ps1" %*
