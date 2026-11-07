<#
.SYNOPSIS
    One-time setup of the ATLAS CQA deployment agent on the Windows host. Safe to run again (it never deletes data).

.DESCRIPTION
    1. Checks Docker Desktop (engine, Compose v2.24+, autostart setting).
    2. Creates C:\hype-cqa\{data,backups,logs,state,secrets,scripts} and copies these scripts to C:\hype-cqa\scripts.
    3. Creates C:\hype-cqa\hype.env from deployment\.env.example (only if it does not exist yet).
    4. Asks for the two GitHub tokens (hidden input), stores them encrypted with DPAPI for this Windows user, and
       restricts C:\hype-cqa\secrets to this user and SYSTEM.
    5. Tests both tokens: reading release runs (GitHub API) and logging in to ghcr.io.
    6. Registers the scheduled tasks (register-task.ps1) and runs the first deployment.

    Run it from the folder that contains it (a checkout or a copy of deployment\windows), in a normal (not
    elevated) PowerShell window, as the Windows user that stays signed in:
        powershell -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
    .\install.ps1
.EXAMPLE
    .\install.ps1 -SetTokens          # replace the stored tokens (e.g. after they expire)
#>
[CmdletBinding()]
param(
    [string]$Root = 'C:\hype-cqa',
    [switch]$SetTokens,
    [switch]$SkipTask,
    [switch]$NoDeploy
)

$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot
Import-Module (Join-Path $source 'HypeCqa.psm1') -Force -DisableNameChecking
$env:HYPE_ROOT = $Root
$paths = Get-HypePaths -Root $Root

function Step { param([string]$Text) Write-Host "`n== $Text" -ForegroundColor Cyan }

# 1. Docker -----------------------------------------------------------------------------------------------------
Step 'Docker Desktop'
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'docker is not on PATH. Install/start Docker Desktop first.' }
if (-not (Wait-HypeDocker -TimeoutSeconds 120)) { throw 'The Docker engine is not running. Start Docker Desktop and run this again.' }
$composeVersion = (Invoke-HypeNative -File 'docker' -Arguments @('compose', 'version', '--short')).Output.Trim()
Write-Host "Docker Compose $composeVersion"
if ($composeVersion -match '^v?(\d+)\.(\d+)' -and ([int]$Matches[1] -lt 2 -or ([int]$Matches[1] -eq 2 -and [int]$Matches[2] -lt 24))) {
    throw "Docker Compose 2.24 or newer is required (found $composeVersion). Update Docker Desktop."
}
$autostart = $null
foreach ($candidate in @((Join-Path $env:APPDATA 'Docker\settings-store.json'), (Join-Path $env:APPDATA 'Docker\settings.json'))) {
    if (Test-Path -LiteralPath $candidate) {
        $json = Get-Content -LiteralPath $candidate -Raw | ConvertFrom-Json
        foreach ($key in @('AutoStart', 'autoStart')) { if ($json.PSObject.Properties[$key]) { $autostart = [bool]$json.$key } }
        break
    }
}
if ($autostart -eq $false) {
    Write-Warning 'Docker Desktop does not start at sign-in. Enable: Docker Desktop > Settings > General > "Start Docker Desktop when you sign in to your computer".'
} elseif ($null -eq $autostart) {
    Write-Host 'Could not read the Docker Desktop autostart setting; make sure "Start Docker Desktop when you sign in" is enabled.'
} else { Write-Host 'Docker Desktop starts at sign-in: yes' }

# 2. Folders and scripts ----------------------------------------------------------------------------------------
Step "Folders under $Root"
Initialize-HypeDirectories -Paths $paths
if ((Resolve-Path $source).Path -ne (Resolve-Path $paths.Scripts).Path) {
    Copy-Item -Path (Join-Path $source '*.ps1'), (Join-Path $source '*.psm1') -Destination $paths.Scripts -Force
    Write-Host "Scripts copied to $($paths.Scripts)"
}
Get-ChildItem -LiteralPath $paths.Scripts -File | Unblock-File -ErrorAction SilentlyContinue

# 3. Settings ---------------------------------------------------------------------------------------------------
Step 'Settings (hype.env)'
$example = Join-Path (Split-Path $source -Parent) '.env.example'          # running from a checkout: deployment\.env.example
if (-not (Test-Path -LiteralPath $example)) { $example = Join-Path $source 'hype.env.example' }   # re-run from scripts\
if (Test-Path -LiteralPath $example) {
    Copy-Item -LiteralPath $example -Destination (Join-Path $paths.Scripts 'hype.env.example') -Force -ErrorAction SilentlyContinue
}
if (-not (Test-Path -LiteralPath $paths.EnvFile)) {
    if (-not (Test-Path -LiteralPath $example)) { throw "Cannot find deployment\.env.example next to this script folder." }
    Copy-Item -LiteralPath $example -Destination $paths.EnvFile
    Write-Host "Created $($paths.EnvFile) from the example. Review it now (PUBLIC_HOSTNAME, model settings)."
    Start-Process notepad.exe -ArgumentList "`"$($paths.EnvFile)`"" -Wait
} else { Write-Host "Keeping the existing $($paths.EnvFile)" }
$config = Get-HypeConfig -Paths $paths
Write-Host "Repository $($config.GITHUB_REPOSITORY), images $($config.IMAGE_PREFIX)-{web,api}, site http://127.0.0.1:$($config.WEB_PORT), public host '$($config.PUBLIC_HOSTNAME)'"

# 4. Tokens -----------------------------------------------------------------------------------------------------
Step 'GitHub tokens (stored encrypted for this Windows user only)'
foreach ($item in @(
        @{ Name = 'github-api'; Prompt = 'Token 1 - GitHub API (fine-grained, repo hype-app, Actions: Read-only)' },
        @{ Name = 'ghcr'; Prompt = 'Token 2 - GHCR pull (classic, scope read:packages only)' })) {
    $file = Join-Path $paths.Secrets "$($item.Name).dpapi"
    if ($SetTokens -or -not (Test-Path -LiteralPath $file)) {
        $value = Read-Host -AsSecureString -Prompt $item.Prompt
        if ($value.Length -lt 20) { throw 'That does not look like a GitHub token.' }
        Save-HypeSecret -Paths $paths -Name $item.Name -Value $value
        Write-Host "Saved $($item.Name)."
    } else { Write-Host "Keeping the stored $($item.Name) token (use -SetTokens to replace it)." }
}
Protect-HypeSecretsDirectory -Paths $paths
Write-Host "Access to $($paths.Secrets) is limited to $([Security.Principal.WindowsIdentity]::GetCurrent().Name) and SYSTEM."

# 5. Test the tokens --------------------------------------------------------------------------------------------
Step 'Testing GitHub access'
try {
    $latest = Get-HypeLatestRelease -Paths $paths -Config $config
    if ($latest) { Write-Host "Newest successful release: $($latest.sha) (run #$($latest.run_number))" -ForegroundColor Green }
    else { Write-Host 'GitHub access works; no successful Release run on main yet (push to main after enabling Actions).' -ForegroundColor Yellow }
} catch { Write-Warning "GitHub API test failed: $($_.Exception.Message)" }
try {
    Connect-HypeRegistry -Paths $paths -Config $config
    Write-Host "Logged in to $($config.IMAGE_PREFIX.Split('/')[0]) as $($config.GHCR_USERNAME)." -ForegroundColor Green
} catch { Write-Warning $_.Exception.Message }

# 6. Tasks and first deployment ---------------------------------------------------------------------------------
if (-not $SkipTask) {
    Step 'Scheduled tasks'
    & (Join-Path $paths.Scripts 'register-task.ps1') -Root $Root -SkipSelfTest
}
if (-not $NoDeploy) {
    Step 'First deployment (the first image download can take several minutes)'
    & (Join-Path $paths.Scripts 'deploy.ps1') -Root $Root
    & (Join-Path $paths.Scripts 'healthcheck.ps1') -Root $Root
}
if (-not $SkipTask) {
    Step 'Checking that the scheduled task runs on its own'
    & (Join-Path $paths.Scripts 'register-task.ps1') -Root $Root
}
Write-Host "`nDone. Status any time: powershell -ExecutionPolicy Bypass -File $($paths.Scripts)\healthcheck.ps1" -ForegroundColor Cyan
