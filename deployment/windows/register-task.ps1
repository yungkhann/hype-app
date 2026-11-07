<#
.SYNOPSIS
    Registers the two scheduled tasks of the deployment agent for the CURRENT Windows user:
      HypeCQA-Deploy   every minute (and at sign-in): deploy.ps1
      HypeCQA-Backup   every 6 hours: backup.ps1

.DESCRIPTION
    The tasks run as this user, only while this user is signed in ("Run only when user is logged on"). That keeps
    Docker Desktop (which runs in this user's session) and the DPAPI-encrypted tokens (bound to this user) usable,
    and works while the screen is locked. No password is stored.

    Windows would flash a console window every minute; the action therefore starts PowerShell through
    "conhost.exe --headless". After registering, the script runs the deploy task once and checks that it actually
    ran; if not, it re-registers with a plain hidden PowerShell window (-WindowStyle Hidden) instead.

.EXAMPLE
    .\register-task.ps1
.EXAMPLE
    .\register-task.ps1 -Unregister
#>
[CmdletBinding()]
param(
    [string]$Root = 'C:\hype-cqa',
    [switch]$Unregister,
    [ValidateSet('Headless', 'Hidden')][string]$WindowMode = 'Headless',
    [ValidateRange(1, 60)][int]$IntervalMinutes = 1,
    [ValidateRange(1, 24)][int]$BackupHours = 6,
    [switch]$SkipSelfTest
)

$ErrorActionPreference = 'Stop'
$deployTask = 'HypeCQA-Deploy'
$backupTask = 'HypeCQA-Backup'

if ($Unregister) {
    foreach ($name in @($deployTask, $backupTask)) {
        if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false
            Write-Host "Removed $name"
        }
    }
    exit 0
}

$scripts = Join-Path $Root 'scripts'
foreach ($file in @('deploy.ps1', 'backup.ps1', 'HypeCqa.psm1')) {
    if (-not (Test-Path -LiteralPath (Join-Path $scripts $file))) { throw "Missing $scripts\$file. Run install.ps1 first." }
}
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name

function New-HypeAction {
    param([string]$Script, [string]$Mode)
    $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scripts\$Script`" -Root `"$Root`""
    if ($Mode -eq 'Headless' -and (Test-Path -LiteralPath $conhost)) {
        return New-ScheduledTaskAction -Execute $conhost -Argument "--headless `"$powershell`" $arguments" -WorkingDirectory $scripts
    }
    return New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $scripts
}

function Register-HypeTasks {
    param([string]$Mode)
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 55) -Hidden

    $every = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
    $logon = New-ScheduledTaskTrigger -AtLogOn -User $user
    $logon.Delay = 'PT1M'
    Register-ScheduledTask -TaskName $deployTask -Force -Principal $principal -Settings $settings `
        -Trigger @($every, $logon) -Action (New-HypeAction -Script 'deploy.ps1' -Mode $Mode) `
        -Description 'ATLAS CQA: deploy the newest successful release from GitHub (C:\hype-cqa\scripts\deploy.ps1).' | Out-Null

    $backup = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(30) -RepetitionInterval (New-TimeSpan -Hours $BackupHours)
    Register-ScheduledTask -TaskName $backupTask -Force -Principal $principal -Settings $settings `
        -Trigger @($backup) -Action (New-HypeAction -Script 'backup.ps1' -Mode $Mode) `
        -Description 'ATLAS CQA: snapshot C:\hype-cqa\data to C:\hype-cqa\backups.' | Out-Null
    Write-Host "Registered $deployTask (every $IntervalMinutes min + at sign-in) and $backupTask (every $BackupHours h) for $user ($Mode)."
}

function Test-HypeTaskRuns {
    # Starts the deploy task and waits for deploy.ps1 to write state\heartbeat.json.
    $heartbeat = Join-Path $Root 'state\heartbeat.json'
    $before = Get-Date
    Start-ScheduledTask -TaskName $deployTask
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 3
        if ((Test-Path -LiteralPath $heartbeat) -and (Get-Item -LiteralPath $heartbeat).LastWriteTime -gt $before) { return $true }
        $state = (Get-ScheduledTask -TaskName $deployTask).State
        if ($state -ne 'Running' -and $i -ge 5) {
            $info = Get-ScheduledTaskInfo -TaskName $deployTask
            if ($info.LastRunTime -gt $before) { return ((Test-Path -LiteralPath $heartbeat) -and (Get-Item -LiteralPath $heartbeat).LastWriteTime -gt $before) }
        }
    }
    return $false
}

Register-HypeTasks -Mode $WindowMode
if ($SkipSelfTest) { exit 0 }

Write-Host 'Checking that the task really runs (up to 90 s)...'
if (Test-HypeTaskRuns) {
    Write-Host 'OK: the deploy task ran and wrote state\heartbeat.json.' -ForegroundColor Green
    exit 0
}
if ($WindowMode -eq 'Headless') {
    Write-Warning 'The headless launcher did not run the script; re-registering with a hidden PowerShell window.'
    Register-HypeTasks -Mode 'Hidden'
    if (Test-HypeTaskRuns) {
        Write-Host 'OK with -WindowStyle Hidden (a console may flash briefly once a minute).' -ForegroundColor Yellow
        exit 0
    }
}
Write-Warning "The task did not write a heartbeat. Open Task Scheduler > $deployTask > History, and C:\hype-cqa\logs."
exit 1
