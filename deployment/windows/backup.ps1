<#
.SYNOPSIS
    Snapshot the application data folder (C:\hype-cqa\data) to C:\hype-cqa\backups. Task Scheduler runs it every
    6 hours (register-task.ps1); deploy.ps1 also takes a snapshot before every deployment.

.DESCRIPTION
    The API writes each JSON file atomically (temporary file + rename), so every file in a copy is complete. To also
    keep files consistent with each other, the API container is paused (frozen, not stopped) for the few seconds the
    copy takes, then resumed. Incomplete temporary files (.tmp-*) are skipped. The last BACKUP_KEEP snapshots of each
    kind are kept. Backups are never restored automatically.
#>
[CmdletBinding()]
param(
    [string]$Root = '',
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'HypeCqa.psm1') -Force -DisableNameChecking
if ($Root) { $env:HYPE_ROOT = $Root }
$paths = Get-HypePaths -Root $Root
Initialize-HypeDirectories -Paths $paths

$lock = Enter-HypeLock -Paths $paths
if (-not $lock) { Write-HypeLog 'A deployment is running (it takes its own snapshot); skipping this backup.' -Name 'backup'; exit 0 }
$exitCode = 0
$paused = $false
$api = (Get-HypeContainerNames).Api
try {
    $config = Get-HypeConfig -Paths $paths
    $current = Get-HypeCurrent -Paths $paths
    $sha = 'none'
    if ($current) { $sha = $current.sha }
    if (-not $NoPause -and (Test-HypeDocker) -and (Get-HypeContainerState -Name $api) -like 'running*') {
        $r = Invoke-HypeNative -File 'docker' -Arguments @('pause', $api)
        $paused = ($r.Code -eq 0)
    }
    $target = Backup-HypeData -Paths $paths -Reason 'periodic' -Sha $sha -Keep ([int]$config.BACKUP_KEEP)
    Write-HypeLog "Backup written: $target" -Name 'backup'
} catch {
    Write-HypeLog "Backup failed: $($_.Exception.Message)" 'ERROR' -Name 'backup'
    $exitCode = 1
} finally {
    if ($paused) { Invoke-HypeNative -File 'docker' -Arguments @('unpause', $api) | Out-Null }
    $lock.Dispose()
}
exit $exitCode
