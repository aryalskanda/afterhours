# Installs Afterhours on Windows. Afterhours runs inside WSL (Linux on Windows), which this sets up.
#
#   irm https://github.com/{{repo}}/releases/latest/download/install.ps1 | iex
#
# What it does, asking before each step:
#   1. turns on WSL with Ubuntu, if it isn't (Windows may ask you to restart; run this again after);
#   2. turns on systemd inside Ubuntu, which Afterhours runs as a background service;
#   3. runs the Linux installer inside Ubuntu (tmux, Claude Code, Afterhours, then `cq setup`);
#   4. adds a sign-in task so Ubuntu, and so Afterhours, is running whenever you are signed in.
#
# Settings, as environment variables:
#   AFTERHOURS_REPO=owner/repo  where releases come from
#   AFTERHOURS_VERSION=v0.6.0   install that release instead of the latest
#   AFTERHOURS_YES=1            answer yes to every question
$ErrorActionPreference = 'Stop'

$repo = if ($env:AFTERHOURS_REPO) { $env:AFTERHOURS_REPO } else { '{{repo}}' }
$distro = 'Ubuntu'

function Say($text) { Write-Host $text }
function Step($text) { Write-Host ""; Write-Host $text -ForegroundColor Cyan }
function Fail($text) { throw $text }
function Ask($question) {
  if ($env:AFTERHOURS_YES -eq '1') { return $true }
  $answer = Read-Host "$question [Y/n]"
  return ($answer -eq '' -or $answer -match '^(y|yes)$')
}
function IsAdmin {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
# The Ubuntu distro, if it's installed (wsl.exe prints UTF-16, hence the replace).
function HasDistro {
  $list = (& wsl.exe --list --quiet 2>$null) -join "`n"
  return (($list -replace "`0", '') -split "`n" | ForEach-Object { $_.Trim() }) -contains $distro
}
function InUbuntu([string]$command) {
  & wsl.exe -d $distro -- bash -lc $command
  return $LASTEXITCODE
}

function Install-Afterhours {
if ($repo -like '*{*') { Fail 'Set $env:AFTERHOURS_REPO to owner/repo: this copy of the script did not come with a release.' }
Say 'Afterhours: line up Claude Code tasks from Telegram; they run on this PC while you are away.'

# --- 1. WSL with Ubuntu -------------------------------------------------------------------------
$wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
if (-not $wsl -or -not (HasDistro)) {
  Step '1. WSL and Ubuntu'
  Say 'Afterhours runs in Ubuntu, inside Windows (WSL). Windows installs it for you.'
  if (-not (IsAdmin)) { Fail 'Installing WSL needs administrator rights. Close this window, open PowerShell with "Run as administrator", and run the command again.' }
  if (-not (Ask 'Install WSL and Ubuntu now?')) { Fail 'Afterhours needs WSL. Run this again when you are ready.' }
  & wsl.exe --install -d $distro
  Say ''
  Say 'Windows may need to restart now. After that, Ubuntu opens and asks you to choose a username and password.'
  Say 'When it is done, close it, and run the same command again to finish.'
  return
}

# Ubuntu has a user (first start done)?
$user = "$(& wsl.exe -d $distro -- bash -c 'id -un' 2>$null)".Trim()
if (-not $user -or $user -eq 'root') {
  Fail "Open Ubuntu once from the Start menu and choose a username and password, then run this command again."
}

# --- 2. systemd inside Ubuntu ---------------------------------------------------------------------
Step '2. Background service support (systemd)'
$hasSystemd = (InUbuntu 'test -d /run/systemd/system') -eq 0
if (-not $hasSystemd) {
  Say 'Turning on systemd in Ubuntu (it needs your Ubuntu password once).'
  if (-not (Ask 'Turn it on and restart Ubuntu?')) { Fail 'Afterhours needs systemd. Run this again when you are ready.' }
  [void](& wsl.exe -d $distro -u root -- bash -c "grep -qs '^systemd=true' /etc/wsl.conf || printf '[boot]\nsystemd=true\n' >> /etc/wsl.conf")
  & wsl.exe --shutdown
  Start-Sleep -Seconds 3
  [void](& wsl.exe -d $distro -- true)
  Start-Sleep -Seconds 5
  if ((InUbuntu 'test -d /run/systemd/system') -ne 0) { Fail 'systemd did not start. Update WSL (run "wsl --update" in PowerShell) and run this again.' }
}
Say 'systemd is on.'

# --- 3. The Linux installer, inside Ubuntu -------------------------------------------------------
Step '3. Afterhours, in Ubuntu'
$version = if ($env:AFTERHOURS_VERSION) { "AFTERHOURS_VERSION=$($env:AFTERHOURS_VERSION) " } else { '' }
$yes = if ($env:AFTERHOURS_YES -eq '1') { 'AFTERHOURS_YES=1 ' } else { '' }
$url = "https://github.com/$repo/releases/latest/download/install.sh"
if ($env:AFTERHOURS_VERSION) { $url = "https://github.com/$repo/releases/download/$($env:AFTERHOURS_VERSION)/install.sh" }
# Already set up (cq installed and paired)? Then only update it: setup would ask everything again.
$ready = (InUbuntu 'test -x "$HOME/.afterhours/bin/cq" && grep -qs ownerId "$HOME/.afterhours/config.json"') -eq 0
$noSetup = if ($ready) { 'AFTERHOURS_NO_SETUP=1 ' } else { '' }
if ($ready) { Say 'Afterhours is already set up in Ubuntu: updating it. This can take a minute, with no output while it downloads.' }
else { Say 'Installing inside Ubuntu: it downloads Afterhours, then asks a few questions here. This can take a minute.' }
$code = InUbuntu "curl -fsSL $url | ${noSetup}${version}${yes}AFTERHOURS_REPO=$repo sh"
if ($code -ne 0) { Fail 'The installer inside Ubuntu did not finish. Read what it said above, fix that, and run this command again.' }

# --- 4. Keep Ubuntu running while you are signed in --------------------------------------------
# WSL stops Ubuntu when nothing is using it, which would stop Afterhours. A task at sign-in holds it open.
Step '4. Keeping Afterhours running'
try {
  # Hidden, so no window sits open; the same task `cq install` makes from inside Ubuntu.
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-WindowStyle Hidden -Command wsl.exe -d $distro --exec sleep infinity"
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
  Register-ScheduledTask -TaskName 'Afterhours' -Action $action -Trigger $trigger -Settings $settings -Description 'Keeps Ubuntu (and Afterhours in it) running while you are signed in.' -Force | Out-Null
  Start-ScheduledTask -TaskName 'Afterhours'
  Say 'Done: Afterhours keeps running whenever you are signed in to Windows.'
} catch {
  Say "Could not add the sign-in task ($($_.Exception.Message))."
  Say 'Afterhours still runs while an Ubuntu window is open. To keep it running without one, run "wsl -d Ubuntu --exec sleep infinity" in a hidden window at sign-in.'
}

Say ''
Say 'All set. To check anything later, open Ubuntu and run: cq doctor'
Say 'To keep working with the lid closed: Control Panel > Power Options > "Choose what closing the lid does" > Do nothing.'
}

# Inside a function, so that an error (or `return`) never closes the window this was pasted into.
try {
  Install-Afterhours
} catch {
  Write-Host ''
  Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
}
