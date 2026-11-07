<#
.SYNOPSIS
    Manual rollback: start the previous (or a given) release again and pause automatic updates.

.DESCRIPTION
    - Without -Sha: goes back to the release recorded in state\previous.json.
    - The release that was running is marked as failed, so the automatic agent will not reinstall it; a NEWER
      release pushed later is deployed normally once you run deploy.ps1 -Unpin.
    - Only application images change. Data is NOT restored: the previous version reads the current data folder.
      To restore data from a snapshot, follow "Restore data from a backup" in docs/WINDOWS_SETUP.md.
    - Uses images already on this PC when GHCR cannot be reached.

.EXAMPLE
    .\rollback.ps1
.EXAMPLE
    .\rollback.ps1 -Sha 0123...cdef
#>
[CmdletBinding()]
param(
    [string]$Sha = '',
    [string]$Root = ''
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'HypeCqa.psm1') -Force -DisableNameChecking
if ($Root) { $env:HYPE_ROOT = $Root }
$paths = Get-HypePaths -Root $Root
Initialize-HypeDirectories -Paths $paths

$lock = $null
for ($i = 0; $i -lt 60 -and -not $lock; $i++) {
    $lock = Enter-HypeLock -Paths $paths
    if (-not $lock) { if ($i -eq 0) { Write-Host 'Waiting for a running deployment to finish...' }; Start-Sleep -Seconds 5 }
}
if (-not $lock) { Write-Error 'A deployment has been running for 5 minutes; try again later.'; exit 1 }

$exitCode = 0
try {
    $config = Get-HypeConfig -Paths $paths
    if (-not (Wait-HypeDocker -TimeoutSeconds 120)) { throw 'Docker is not available.' }
    $current = Get-HypeCurrent -Paths $paths
    $previous = Read-HypeJson -Path (Get-HypeStateFile $paths 'previous')

    if ($Sha) {
        if ($Sha -cnotmatch '^[0-9a-f]{40}$') { throw 'Pass the full 40-character lowercase commit SHA.' }
        $target = New-HypeReleaseRecord -Config $config -Sha $Sha
    } elseif ($previous) {
        $target = $previous
    } else {
        throw 'No previous release is recorded. Pass -Sha <commit> (see state\history.jsonl for deployed commits).'
    }
    if ($current -and $current.sha -eq $target.sha) { throw "Release $($target.sha) is already the current one." }

    Write-HypeLog "Manual rollback from $(if ($current) { $current.sha } else { 'nothing' }) to $($target.sha)." 'WARN'
    if ($current) {
        # Keep the agent from reinstalling the release we are leaving.
        Set-HypeFailure -Paths $paths -Sha $current.sha -ErrorText 'rolled back manually' `
            -Attempts ([int]$config.MAX_ATTEMPTS_PER_RELEASE)
    }
    $ok = Invoke-HypeDeploy -Paths $paths -Config $config -Release $target
    if ($ok) {
        Write-HypeJson -Path (Get-HypeStateFile $paths 'pin') -Value ([pscustomobject]@{
            sha = $target.sha; at = (Get-Date).ToString('o'); reason = 'manual rollback' })
        Write-HypeLog "Rolled back to $($target.sha). Automatic updates are paused; resume with deploy.ps1 -Unpin." 'WARN'
    } else {
        Write-HypeLog "Rollback to $($target.sha) failed; see the log above and run healthcheck.ps1." 'ERROR'
        $exitCode = 1
    }
} catch {
    Write-HypeLog "rollback.ps1 error: $($_.Exception.Message)" 'ERROR'
    $exitCode = 1
} finally {
    $lock.Dispose()
}
exit $exitCode
