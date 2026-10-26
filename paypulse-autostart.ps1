# Keeps PayPulse running on this PC without anyone starting it by hand.
#
#   powershell -ExecutionPolicy Bypass -File paypulse-autostart.ps1          turn ON
#   powershell -ExecutionPolicy Bypass -File paypulse-autostart.ps1 -Remove  turn OFF
#
# Registers the Windows scheduled task "PayPulse auto-start": when you log in to Windows, and then
# every 10 minutes, it runs start-paypulse.ps1 hidden. That script only (re)starts what is down
# (database, app, public link) and rewrites the "PayPulse" shortcut on the Desktop with the current
# link. The link itself still changes after a restart (free Cloudflare quick tunnel) and nothing runs
# while the PC is asleep or off: for one permanent link, deploy to Render (see render.yaml).
param([switch]$Remove)

$taskName = 'PayPulse auto-start'
$root = $PSScriptRoot

if ($Remove) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed the scheduled task '$taskName'."
  return
}

$script = Join-Path $root 'start-paypulse.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $root `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" -NoPause -NoBrowser -Quiet"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 10)).Repetition
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Starts PayPulse (database, app, public link) at logon and checks it every 10 minutes.' -Force | Out-Null
Write-Host "Scheduled task '$taskName' is ON: PayPulse starts at logon and is checked every 10 minutes."
