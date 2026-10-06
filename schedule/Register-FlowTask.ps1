<#
.SYNOPSIS
  Creates (or removes) a Windows scheduled task that opens Google Flow in its own Chrome
  window every day, so the Flow Bulk Downloader userscript's "Run on page load" setting can
  do an unattended daily pull.

.EXAMPLE
  # Open Flow every day at 08:00 and go straight to one project (best for Upscaled mode)
  .\Register-FlowTask.ps1 -Time 08:00 -Url "https://flow.google.com/project/00000000-0000-0000-0000-000000000000"

.EXAMPLE
  # Use a specific Chrome profile (the one that is signed in to Flow)
  .\Register-FlowTask.ps1 -Time 07:30 -ProfileDirectory "Profile 2"

.EXAMPLE
  .\Register-FlowTask.ps1 -Unregister

.NOTES
  - In the userscript panel set Automation -> "Run on page load if last run older than" (e.g. 20 h)
    and, for Upscaled mode, the "Auto project" so the home page redirects to that project.
  - Chrome must already be signed in to Flow in the chosen profile; this script never handles passwords.
  - The task runs only when you are logged on (interactive session), because Chrome needs a desktop.
  - Keep the Flow window in the foreground while an Upscaled run is going; Flow only renders tiles while visible.
#>
[CmdletBinding()]
param(
  [string]$TaskName = "Flow Bulk Downloader",
  [string]$Time = "08:00",
  [string]$Url = "https://flow.google.com/",
  [string]$ChromePath = "",
  [string]$ProfileDirectory = "",
  [switch]$Unregister
)

if ($Unregister) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'."
  } else {
    Write-Host "No scheduled task named '$TaskName'."
  }
  return
}

if (-not $ChromePath) {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  )
  $ChromePath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $ChromePath -or -not (Test-Path $ChromePath)) {
  throw "Chrome/Edge not found. Pass -ChromePath 'C:\path\to\chrome.exe'."
}

$args = @("--new-window")
if ($ProfileDirectory) { $args += "--profile-directory=`"$ProfileDirectory`"" }
$args += "`"$Url`""

$action  = New-ScheduledTaskAction -Execute $ChromePath -Argument ($args -join " ")
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Hours 6) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Registered '$TaskName': every day at $Time -> $ChromePath $($args -join ' ')"
Write-Host "Test it now with:  Start-ScheduledTask -TaskName '$TaskName'"
