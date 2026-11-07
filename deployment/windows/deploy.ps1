<#
.SYNOPSIS
    ATLAS CQA deployment agent. Task Scheduler runs it every minute (see register-task.ps1); you can run it by hand.

.DESCRIPTION
    Automatic mode (no arguments):
      1. Waits for Docker Desktop (starts it if needed; retries next minute if the engine is still starting).
      2. Asks GitHub for the newest successful "Release" workflow run on main. A successful run means CI passed and
         both images (web + api) were published with the same commit SHA tag and verified together.
      3. If that commit is already running: makes sure the containers are up (restart recovery) and exits.
      4. Otherwise: pulls both images, snapshots data\, switches with docker compose, checks health through
         http://127.0.0.1:<WEB_PORT>, and records the result. If the new release fails, the previous one is started
         again (images only; data is never rolled back automatically). A failing release is retried after 5, 10
         minutes and then skipped until a newer release appears.
    Network/registry problems are retried quietly on the next run without counting as a failed release.

.EXAMPLE
    .\deploy.ps1                    # what the scheduled task runs
.EXAMPLE
    .\deploy.ps1 -Sha 0123...cdef   # deploy exactly this commit (full 40-character SHA) and pin it
.EXAMPLE
    .\deploy.ps1 -Unpin             # resume automatic updates after a manual deploy or a rollback
#>
[CmdletBinding()]
param(
    [string]$Sha = '',
    [switch]$Force,
    [switch]$NoPin,
    [switch]$Unpin,
    [string]$Root = ''
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'HypeCqa.psm1') -Force -DisableNameChecking
if ($Root) { $env:HYPE_ROOT = $Root }
$paths = Get-HypePaths -Root $Root
Initialize-HypeDirectories -Paths $paths

function Write-Transient {
    # The same transient problem is logged at most every 30 minutes (the heartbeat file always has the latest).
    param([string]$Message)
    $file = Get-HypeStateFile $paths 'heartbeat'
    $beat = Read-HypeJson -Path $file
    $since = (Get-Date).ToString('o')
    $log = $true
    if ($beat -and $beat.result -eq 'transient' -and $beat.detail -eq $Message -and $beat.PSObject.Properties['since']) {
        if ((Get-HypeAgeMinutes -Value $beat.since) -lt 30) { $since = $beat.since; $log = $false }
    }
    if ($log) { Write-HypeLog $Message 'WARN' }
    Write-HypeJson -Path $file -Value ([pscustomobject]@{ at = (Get-Date).ToString('o'); result = 'transient';
        detail = $Message; since = $since; pid = $PID })
}

function Repair-HypeStack {
    # Restart recovery: after a reboot or a crash the deployed release must be running. Docker's restart policy
    # normally does this; this covers removed containers and containers stuck unhealthy.
    param($Config, $Current)
    if (-not $Current) { return }
    $names = Get-HypeContainerNames
    $api = Get-HypeContainerState -Name $names.Api
    $web = Get-HypeContainerState -Name $names.Web
    if ($api -like 'running*' -and $web -like 'running*' -and $api -notlike '*unhealthy*' -and $web -notlike '*unhealthy*') { return }
    $repairFile = Get-HypeStateFile $paths 'repair'
    $last = Read-HypeJson -Path $repairFile
    if ($last) {
        if ((Get-HypeAgeMinutes -Value $last.at) -lt 10) { return }
    }
    Write-HypeJson -Path $repairFile -Value ([pscustomobject]@{ at = (Get-Date).ToString('o'); api = $api; web = $web })
    Write-HypeLog "Stack is not healthy (api: '$api', web: '$web'); restarting release $($Current.sha)." 'WARN'
    foreach ($pair in @(@($names.Api, $api), @($names.Web, $web))) {
        if ($pair[1] -like '*unhealthy*') { Invoke-HypeNative -File 'docker' -Arguments @('restart', $pair[0]) | Out-Null }
    }
    try {
        Start-HypeRelease -Paths $paths -Config $Config -Release $Current
        Write-HypeLog "Release $($Current.sha) is running again."
    } catch {
        Write-HypeLog "Restart of $($Current.sha) failed: $($_.Exception.Message)" 'ERROR'
    }
}

$lock = Enter-HypeLock -Paths $paths
if (-not $lock) { Write-Host 'Another deploy.ps1 is running; nothing to do.'; exit 0 }
$exitCode = 0
try {
    $config = Get-HypeConfig -Paths $paths
    Remove-HypeOldLogs -Paths $paths -KeepDays ([int]$config.LOG_KEEP_DAYS)
    $pinFile = Get-HypeStateFile $paths 'pin'

    if ($Unpin) {
        if (Test-Path -LiteralPath $pinFile) { Remove-Item -LiteralPath $pinFile -Force }
        Write-HypeLog 'Automatic updates resumed (pin removed).'
        if (-not $Sha) { exit 0 }
    }

    if (-not (Wait-HypeDocker -TimeoutSeconds 45)) {
        Write-Transient 'Docker engine is not available yet; will retry.'
        exit 0
    }
    $current = Get-HypeCurrent -Paths $paths

    if ($Sha) {
        # ---- manual: exactly this commit ---------------------------------------------------------------------
        if ($Sha -cnotmatch '^[0-9a-f]{40}$') { throw 'Pass the full 40-character lowercase commit SHA.' }
        $meta = $null
        try { $meta = Get-HypeReleaseForSha -Paths $paths -Config $config -Sha $Sha }
        catch { Write-HypeLog "Could not check GitHub for $Sha ($($_.Exception.Message))." 'WARN' }
        if (-not $meta -and -not $Force) {
            throw "$Sha is not a successful Release run on $($config.RELEASE_BRANCH). Use -Force to deploy it anyway."
        }
        $release = New-HypeReleaseRecord -Config $config -Sha $Sha -Meta $meta
        $ok = Invoke-HypeDeploy -Paths $paths -Config $config -Release $release
        if ($ok -and -not $NoPin) {
            Write-HypeJson -Path $pinFile -Value ([pscustomobject]@{ sha = $Sha; at = (Get-Date).ToString('o'); reason = 'manual deploy' })
            Write-HypeLog "Pinned to ${Sha}; automatic updates are paused. Resume with: deploy.ps1 -Unpin" 'WARN'
        }
        if (-not $ok) { $exitCode = 1 }
        Write-HypeHeartbeat -Paths $paths -Result $(if ($ok) { 'deployed' } else { 'failed' }) -Detail $Sha
        exit $exitCode
    }

    # ---- automatic ---------------------------------------------------------------------------------------------
    $pin = Read-HypeJson -Path $pinFile
    if ($pin) {
        Repair-HypeStack -Config $config -Current $current
        Write-HypeHeartbeat -Paths $paths -Result 'pinned' -Detail $pin.sha
        exit 0
    }

    try {
        $latest = Get-HypeLatestRelease -Paths $paths -Config $config
    } catch {
        Write-Transient "Could not read releases from GitHub: $($_.Exception.Message)"
        Repair-HypeStack -Config $config -Current $current
        exit 0
    }
    if (-not $latest) {
        Write-HypeHeartbeat -Paths $paths -Result 'waiting' -Detail 'No successful release on GitHub yet.'
        Repair-HypeStack -Config $config -Current $current
        exit 0
    }
    if ($current -and $current.sha -eq $latest.sha) {
        Repair-HypeStack -Config $config -Current $current
        Write-HypeHeartbeat -Paths $paths -Result 'up-to-date' -Detail $latest.sha
        exit 0
    }
    if ($current -and [int]$current.run_number -gt 0 -and $latest.run_number -lt [int]$current.run_number) {
        # Never move backwards on our own (e.g. after the newest run was deleted or re-run).
        Repair-HypeStack -Config $config -Current $current
        Write-HypeHeartbeat -Paths $paths -Result 'up-to-date' -Detail "deployed run #$($current.run_number) is newer than #$($latest.run_number)"
        exit 0
    }
    $failures = Get-HypeFailures -Paths $paths
    $failure = $null
    if ($failures.ContainsKey($latest.sha)) { $failure = $failures[$latest.sha] }
    if (-not (Test-HypeRetryAllowed -Failure $failure -MaxAttempts ([int]$config.MAX_ATTEMPTS_PER_RELEASE))) {
        Repair-HypeStack -Config $config -Current $current
        Write-HypeHeartbeat -Paths $paths -Result 'skipping' -Detail "release $($latest.sha) failed $($failure.attempts) time(s); waiting for a newer release"
        exit 0
    }

    $release = New-HypeReleaseRecord -Config $config -Sha $latest.sha -Meta $latest
    try {
        $ok = Invoke-HypeDeploy -Paths $paths -Config $config -Release $release -CountFailure
    } catch [System.Net.WebException] {
        Write-Transient "Release $($latest.sha) not deployed yet: $($_.Exception.Message)"
        Repair-HypeStack -Config $config -Current $current
        exit 0
    }
    if ($ok) {
        Write-HypeHeartbeat -Paths $paths -Result 'deployed' -Detail $latest.sha
    } else {
        Write-HypeHeartbeat -Paths $paths -Result 'failed' -Detail $latest.sha
        $exitCode = 1
    }
} catch {
    Write-HypeLog "deploy.ps1 error: $($_.Exception.Message)" 'ERROR'
    Write-HypeHeartbeat -Paths $paths -Result 'error' -Detail $_.Exception.Message
    $exitCode = 1
} finally {
    $lock.Dispose()
}
exit $exitCode
