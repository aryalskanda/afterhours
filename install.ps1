# Installs Afterhours on Windows 10 (1809 or newer) and Windows 11, natively: no WSL, no
# administrator rights.
#
#   irm https://github.com/{{repo}}/releases/latest/download/install.ps1 | iex
#
# What it does, asking before it installs anything:
#   1. Git for Windows, if it's missing (Claude Code runs its commands with Git Bash), with winget;
#   2. Claude Code, if it's missing, with Anthropic's own installer;
#   3. cq.exe, checked against the release's checksums, in %USERPROFILE%\.afterhours\bin, and that
#      folder on your Path;
#   4. `cq setup`: signing Claude in, your code folders, the defaults, starting Afterhours in the
#      background whenever you sign in to Windows, and your Telegram bot.
#
# Settings, as environment variables:
#   AFTERHOURS_REPO=owner/repo      where releases come from
#   AFTERHOURS_VERSION=v0.6.0       install that release instead of the latest
#   AFTERHOURS_YES=1                answer yes to every question
#   AFTERHOURS_BINARY=C:\...\cq.exe install this file instead of downloading one (for testing a build)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is many times slower with its progress bar

$repo = if ($env:AFTERHOURS_REPO) { $env:AFTERHOURS_REPO } else { '{{repo}}' }
$asset = 'cq-windows-x64.exe'

function Say($text) { Write-Host $text }
function Step($text) { Write-Host ""; Write-Host $text -ForegroundColor Cyan }
function Fail($text) { throw $text }
function Ask($question) {
  if ($env:AFTERHOURS_YES -eq '1') { return $true }
  $answer = Read-Host "$question [Y/n]"
  return ($answer -eq '' -or $answer -match '^(y|yes)$')
}
# This window's Path again from the registry, so programs just installed are found.
function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}
function Find-GitBash {
  $candidates = @($env:CLAUDE_CODE_GIT_BASH_PATH)
  foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, "$env:LOCALAPPDATA\Programs")) {
    if ($root) { $candidates += Join-Path $root 'Git\bin\bash.exe' }
  }
  $git = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($git) { $candidates += Join-Path (Split-Path (Split-Path $git.Source)) 'bin\bash.exe' }
  return $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
# The real claude.exe: Anthropic's installer puts it in ~\.local\bin; npm keeps it under node_modules.
function Find-Claude {
  $native = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
  if (Test-Path $native) { return $native }
  $found = Get-Command claude.exe, claude.cmd, claude -ErrorAction SilentlyContinue | Select-Object -First 1
  return $found
}

function Install-Afterhours {
if ($repo -like '*{*' -and -not $env:AFTERHOURS_BINARY) { Fail 'Set $env:AFTERHOURS_REPO to owner/repo: this copy of the script did not come with a release.' }
Say 'Afterhours: line up Claude Code tasks from Telegram; they run on this PC while you are away.'

# --- Windows itself ------------------------------------------------------------------------------
$build = [Environment]::OSVersion.Version.Build
if ($build -lt 17763) { Fail "This is Windows build $build. Afterhours needs Windows 10 version 1809 (build 17763) or newer: update Windows, then run this again." }
if (-not [Environment]::Is64BitOperatingSystem) { Fail 'Afterhours needs 64-bit Windows.' }

# --- 1. Git for Windows ----------------------------------------------------------------------------
Step '1. Git for Windows'
if (-not (Find-GitBash)) {
  Say 'Claude Code on Windows runs its commands with Git Bash, which comes with Git for Windows.'
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) { Fail 'Install Git for Windows from https://git-scm.com/downloads/win, open a new PowerShell window, and run this again.' }
  if (-not (Ask 'Install Git for Windows now (winget install Git.Git)?')) { Fail 'Afterhours needs Git for Windows. Run this again when you are ready.' }
  & winget.exe install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
  Refresh-Path
  if (-not (Find-GitBash)) { Fail 'Git did not install. Install it from https://git-scm.com/downloads/win, then run this again.' }
}
Say "Git Bash: $(Find-GitBash)"

# --- 2. Claude Code ----------------------------------------------------------------------------------
Step '2. Claude Code'
if (-not (Find-Claude)) {
  Say 'Afterhours runs Claude Code, Anthropic''s coding assistant, with your own Claude account.'
  if (-not (Ask 'Install Claude Code now (its official installer, from claude.ai)?')) { Fail 'Install Claude Code (https://claude.com/claude-code), then run this again.' }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -Command 'irm https://claude.ai/install.ps1 | iex'
  Refresh-Path
  if (-not (Find-Claude)) { Fail 'Claude Code did not install. See https://claude.com/claude-code, then run this again.' }
}
Say 'Claude Code is installed.'

# --- 3. cq.exe -----------------------------------------------------------------------------------
Step '3. Afterhours'
$home_ = if ($env:CQ_HOME) { $env:CQ_HOME } else { Join-Path $env:USERPROFILE '.afterhours' }
$bin = Join-Path $home_ 'bin'
$cq = Join-Path $bin 'cq.exe'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
# Ends in .exe, so Windows runs it for the check below.
$new = Join-Path $bin "cq.$PID.new.exe"
if ($env:AFTERHOURS_BINARY) {
  Say "Using $($env:AFTERHOURS_BINARY)"
  Copy-Item -LiteralPath $env:AFTERHOURS_BINARY -Destination $new -Force
} else {
  $base = if ($env:AFTERHOURS_VERSION) { "https://github.com/$repo/releases/download/$($env:AFTERHOURS_VERSION)" } else { "https://github.com/$repo/releases/latest/download" }
  Say "Downloading $asset from $base"
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $new
  $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS").Content
  if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
  $expected = ($sums -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match "^([0-9a-fA-F]{64})\s+\*?$([regex]::Escape($asset))$" } | ForEach-Object { $Matches[1] } | Select-Object -First 1)
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $new).Hash
  if (-not $expected -or $actual -ne $expected.ToUpper()) {
    Remove-Item -LiteralPath $new -Force
    Fail "The download of $asset does not match the release's checksum; nothing was installed."
  }
  Say 'Checked it against the release''s checksums.'
}
Unblock-File -LiteralPath $new -ErrorAction SilentlyContinue
& $new version | Out-Null
if ($LASTEXITCODE -ne 0) { Remove-Item -LiteralPath $new -Force; Fail 'The downloaded cq.exe does not run on this PC.' }
# A cq.exe that is running can't be replaced, but it can be moved aside; Afterhours deletes it later.
if (Test-Path -LiteralPath $cq) { Move-Item -LiteralPath $cq -Destination "$cq.old-$([DateTimeOffset]::Now.ToUnixTimeMilliseconds())" -Force }
Move-Item -LiteralPath $new -Destination $cq
Say "Installed $cq ($(& $cq version))"

# On your Path (new windows see it), through the registry so your other %VARIABLES% stay as they are.
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$parts = @(([string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')) -split ';' | Where-Object { $_ })
if (-not ($parts | Where-Object { $_.TrimEnd('\') -eq $bin })) {
  $key.SetValue('Path', (($parts + $bin) -join ';'), 'ExpandString')
  # Tells Windows (and new windows) the Path changed.
  [Environment]::SetEnvironmentVariable('AFTERHOURS_PATH_CHANGED', '1', 'User')
  [Environment]::SetEnvironmentVariable('AFTERHOURS_PATH_CHANGED', $null, 'User')
  Say "Added $bin to your Path."
}
if (-not (($env:Path -split ';') -contains $bin)) { $env:Path = "$env:Path;$bin" }

# The old way (Afterhours inside WSL) kept Ubuntu running with a scheduled task; it isn't needed now.
$old = Get-ScheduledTask -TaskName 'Afterhours' -ErrorAction SilentlyContinue
if ($old -and $old.Actions.Execute -match 'wsl') {
  Say ''
  Say 'An earlier Afterhours ran inside WSL (Ubuntu), with a scheduled task that keeps Ubuntu running.'
  Say 'Afterhours now runs on Windows itself. Stop the one in Ubuntu (run "cq uninstall" there) so only one uses your Telegram bot.'
  if (Ask 'Remove the scheduled task that keeps Ubuntu running?') { Unregister-ScheduledTask -TaskName 'Afterhours' -Confirm:$false }
}

# --- 4. cq setup -------------------------------------------------------------------------------------
Step '4. Setting it up (cq setup)'
& $cq setup
Say ''
Say 'To check anything later, open PowerShell or Windows Terminal and run: cq doctor'
Say "(In a window that was already open, run it as: & `"$cq`" doctor)"
}

# Inside a function, so that an error (or `return`) never closes the window this was pasted into.
try {
  Install-Afterhours
} catch {
  Write-Host ''
  Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
}
