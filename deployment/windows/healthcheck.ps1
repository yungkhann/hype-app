<#
.SYNOPSIS
    Status report for the ATLAS CQA deployment: agent, release, containers, website, API routing, model service.

.DESCRIPTION
    Exit code 0 when the website and API are healthy, 1 otherwise. The model service is reported separately and
    never makes this check fail: the site is designed to keep working while the model is offline.

.EXAMPLE
    .\healthcheck.ps1
#>
[CmdletBinding()]
param([string]$Root = '')

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'HypeCqa.psm1') -Force -DisableNameChecking
if ($Root) { $env:HYPE_ROOT = $Root }
$paths = Get-HypePaths -Root $Root
$config = Get-HypeConfig -Paths $paths
$names = Get-HypeContainerNames
$healthy = $true

function Show { param([string]$Label, [string]$Value, [string]$Status = 'info')
    $color = @{ ok = 'Green'; warn = 'Yellow'; fail = 'Red'; info = 'Gray' }[$Status]
    Write-Host ("{0,-22} " -f $Label) -NoNewline
    Write-Host $Value -ForegroundColor $color
}

Write-Host "`nATLAS CQA deployment status ($($paths.Root))`n"

# Agent
$beat = Read-HypeJson -Path (Get-HypeStateFile $paths 'heartbeat')
if ($beat) {
    $age = [int]((Get-HypeAgeMinutes -Value $beat.at) * 60)
    $status = 'ok'
    if ($age -gt 300) { $status = 'warn' }
    Show 'Agent last ran' "$age s ago: $($beat.result) $($beat.detail)" $status
} else { Show 'Agent last ran' 'never (run register-task.ps1)' 'warn' }
if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
    foreach ($task in @('HypeCQA-Deploy', 'HypeCQA-Backup')) {
        $t = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
        if ($t) {
            $info = Get-ScheduledTaskInfo -TaskName $task
            Show $task "$($t.State), last run $($info.LastRunTime), result $($info.LastTaskResult)" $(if ($t.State -eq 'Disabled') { 'warn' } else { 'ok' })
        } else { Show $task 'not registered' 'warn' }
    }
}

# Release
$current = Get-HypeCurrent -Paths $paths
$previous = Read-HypeJson -Path (Get-HypeStateFile $paths 'previous')
$pin = Read-HypeJson -Path (Get-HypeStateFile $paths 'pin')
if ($current) { Show 'Deployed release' "$($current.sha) (run #$($current.run_number), $($current.deployed_at))" 'ok' }
else { Show 'Deployed release' 'none yet' 'warn' }
if ($previous) { Show 'Previous release' $previous.sha }
if ($pin) { Show 'Automatic updates' "PAUSED, pinned to $($pin.sha) ($($pin.reason)); deploy.ps1 -Unpin resumes" 'warn' }
else { Show 'Automatic updates' 'on' 'ok' }
$failures = Get-HypeFailures -Paths $paths
foreach ($sha in $failures.Keys) { Show 'Failed release' "$sha x$($failures[$sha].attempts): $($failures[$sha].error)" 'warn' }

# Docker and containers
if (Test-HypeDocker) {
    Show 'Docker engine' 'running' 'ok'
    foreach ($name in @($names.Api, $names.Web)) {
        $state = Get-HypeContainerState -Name $name
        $ok = ($state -like 'running*' -and $state -notlike '*unhealthy*')
        if (-not $ok) { $healthy = $false }
        Show $name "$(if ($state) { $state } else { 'missing' })  $(Get-HypeContainerImage -Name $name)" $(if ($ok) { 'ok' } else { 'fail' })
    }
} else {
    Show 'Docker engine' 'NOT running' 'fail'
    $healthy = $false
}

# Website and API routing (what the browser uses)
$problems = @(Test-HypeAppHealth -Config $config)
if ($problems.Count -eq 0) { Show 'Website + API' "http://127.0.0.1:$($config.WEB_PORT) ok (frontend, /api/v1/health, CQA store)" 'ok' }
else { $healthy = $false; foreach ($p in $problems) { Show 'Website + API' $p 'fail' } }
$warning = Test-HypePublicHost -Config $config
if ($warning) { Show 'Public host name' $warning 'warn' } else { Show 'Public host name' "$($config.PUBLIC_HOSTNAME) accepted by the API" 'ok' }
if ($config.PUBLIC_HOSTNAME) {
    $public = Invoke-HypeHttp -Url "https://$($config.PUBLIC_HOSTNAME)/healthz" -TimeoutSec 10
    if ($public.Status -eq 200) { Show 'Through Cloudflare' "https://$($config.PUBLIC_HOSTNAME)/healthz ok" 'ok' }
    elseif ($public.Status -in 301, 302, 303, 307, 401, 403) { Show 'Through Cloudflare' "HTTP $($public.Status) (Cloudflare Access login in front of the site?)" 'info' }
    else { Show 'Through Cloudflare' "HTTP $($public.Status) $($public.Body)" 'warn' }
}

# Model service (informational only)
$file = Read-HypeEnvFile -Path $paths.EnvFile
$evaluator = if ($file['ATLAS_CQA_EVALUATOR']) { $file['ATLAS_CQA_EVALUATOR'] } else { 'mock' }
$modelUrl = [string]$file['ATLAS_CQA_EVALUATOR_URL']
Show 'Evaluator' "$evaluator$(if ($evaluator -eq 'mock') { ' (development mock, not AI)' })"
if ($modelUrl) {
    $probe = if ($config.MODEL_HEALTH_URL) { $config.MODEL_HEALTH_URL } else { $modelUrl }
    $hostSide = $probe -replace 'host\.docker\.internal', '127.0.0.1'
    $fromHost = Invoke-HypeHttp -Url $hostSide -TimeoutSec 5
    Show 'Model (from Windows)' "$hostSide -> $(if ($fromHost.Status) { "HTTP $($fromHost.Status) (listening)" } else { "unreachable: $($fromHost.Body)" })" $(if ($fromHost.Status) { 'ok' } else { 'warn' })
    if ((Get-HypeContainerState -Name $names.Api) -like 'running*') {
        $code = "import sys,urllib.request,urllib.error`nu=sys.argv[1]`ntry:`n r=urllib.request.urlopen(u,timeout=5);print('HTTP',r.status,'(reachable)')`nexcept urllib.error.HTTPError as e:`n print('HTTP',e.code,'(reachable)')`nexcept Exception as e:`n print('UNREACHABLE',e);sys.exit(2)"
        $r = Invoke-HypeNative -File 'docker' -Arguments @('exec', $names.Api, 'python', '-c', $code, $probe)
        Show 'Model (from Docker)' "$probe -> $($r.Output.Trim())" $(if ($r.Code -eq 0) { 'ok' } else { 'warn' })
    }
} elseif ($evaluator -eq 'http') {
    Show 'Model' 'ATLAS_CQA_EVALUATOR=http but ATLAS_CQA_EVALUATOR_URL is empty' 'warn'
}
$ollama = Invoke-HypeHttp -Url "$($config.OLLAMA_URL)/api/version" -TimeoutSec 3
Show 'Ollama' "$($config.OLLAMA_URL) -> $(if ($ollama.Status -eq 200) { $ollama.Body } else { 'not answering' })" $(if ($ollama.Status -eq 200) { 'ok' } else { 'info' })

Write-Host ''
if ($healthy) { Write-Host 'Overall: HEALTHY' -ForegroundColor Green; exit 0 }
Write-Host 'Overall: NOT HEALTHY (see above; logs in C:\hype-cqa\logs)' -ForegroundColor Red
exit 1
