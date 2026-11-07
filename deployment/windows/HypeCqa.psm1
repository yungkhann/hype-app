# HypeCqa.psm1 - shared functions for the ATLAS CQA Windows deployment agent.
#
# Compatible with Windows PowerShell 5.1 (built into Windows 11) and PowerShell 7. Keep this file ASCII-only:
# Windows PowerShell reads BOM-less scripts in the ANSI code page.
#
# Layout under the deployment root (default C:\hype-cqa):
#   hype.env      settings (install.ps1 copies deployment/.env.example here; edit this one)
#   api.env       optional extra ATLAS_* settings for the API container
#   scripts\      these scripts
#   data\         persistent application data (bind-mounted into the API container as /data)
#   backups\      data snapshots (before every deployment, and every 6 hours)
#   logs\         deploy-YYYYMMDD.log, backup-YYYYMMDD.log (LOG_KEEP_DAYS kept)
#   state\        current.json, previous.json, failures.json, pin.json, history.jsonl, heartbeat.json,
#                 releases\<sha>\compose.prod.yml
#   secrets\      DPAPI-encrypted tokens, readable only by this Windows user and SYSTEM

Set-StrictMode -Version 2.0

$script:ProjectName = 'hype-cqa'
$script:ApiContainer = 'hype-cqa-api-1'
$script:WebContainer = 'hype-cqa-web-1'
$script:ComposePathInImage = '/opt/atlas/deploy/compose.prod.yml'
$script:Defaults = [ordered]@{
    GITHUB_REPOSITORY        = 'yungkhann/hype-app'
    RELEASE_WORKFLOW         = 'release.yml'
    RELEASE_BRANCH           = 'main'
    IMAGE_PREFIX             = 'ghcr.io/yungkhann/hype-app'
    GHCR_USERNAME            = 'yungkhann'
    WEB_PORT                 = '3000'
    PUBLIC_HOSTNAME          = ''
    DEPLOY_HEALTH_TIMEOUT_S  = '240'
    APP_HEALTH_TIMEOUT_S     = '90'
    MAX_ATTEMPTS_PER_RELEASE = '3'
    BACKUP_KEEP              = '20'
    LOG_KEEP_DAYS            = '14'
    IMAGES_KEEP              = '3'
    MODEL_HEALTH_URL         = ''
    OLLAMA_URL               = 'http://127.0.0.1:11434'
}

function Get-HypeProjectName { return $script:ProjectName }
function Get-HypeContainerNames { return [pscustomobject]@{ Api = $script:ApiContainer; Web = $script:WebContainer } }

# ---- paths, config, logging ----------------------------------------------------------------------------------

function Get-HypePaths {
    param([string]$Root = '')
    if (-not $Root) { if ($env:HYPE_ROOT) { $Root = $env:HYPE_ROOT } else { $Root = 'C:\hype-cqa' } }
    $state = Join-Path $Root 'state'
    return [pscustomobject]@{
        Root     = $Root
        EnvFile  = Join-Path $Root 'hype.env'
        Data     = Join-Path $Root 'data'
        Backups  = Join-Path $Root 'backups'
        Logs     = Join-Path $Root 'logs'
        State    = $state
        Releases = Join-Path $state 'releases'
        Secrets  = Join-Path $Root 'secrets'
        Scripts  = Join-Path $Root 'scripts'
        Lock     = Join-Path $state 'deploy.lock'
    }
}

function Initialize-HypeDirectories {
    param($Paths)
    foreach ($dir in @($Paths.Root, $Paths.Data, $Paths.Backups, $Paths.Logs, $Paths.State, $Paths.Releases,
                       $Paths.Secrets, $Paths.Scripts)) {
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    }
}

function Read-HypeEnvFile {
    # Minimal dotenv reader matching what Docker Compose accepts: KEY=VALUE, # comments, optional quotes.
    param([string]$Path)
    $values = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $values }
    foreach ($line in [IO.File]::ReadAllLines($Path)) {
        $text = $line.Trim().TrimStart([char]0xFEFF)
        if ($text.Length -eq 0 -or $text.StartsWith('#')) { continue }
        $eq = $text.IndexOf('=')
        if ($eq -lt 1) { continue }
        $key = $text.Substring(0, $eq).Trim()
        if ($key.StartsWith('export ')) { $key = $key.Substring(7).Trim() }
        $value = $text.Substring($eq + 1).Trim()
        if ($value.Length -ge 2 -and (($value.StartsWith("'") -and $value.EndsWith("'")) -or
                                      ($value.StartsWith('"') -and $value.EndsWith('"')))) {
            $value = $value.Substring(1, $value.Length - 2)
        } elseif ($value -match '^(.*?)\s+#') {
            $value = $Matches[1].Trim()
        }
        $values[$key] = $value
    }
    return $values
}

function Get-HypeConfig {
    param($Paths)
    $file = Read-HypeEnvFile -Path $Paths.EnvFile
    $settings = @{}
    foreach ($key in $script:Defaults.Keys) { $settings[$key] = $script:Defaults[$key] }
    foreach ($key in $file.Keys) { if ($file[$key] -ne '') { $settings[$key] = $file[$key] } }
    if ($settings.GITHUB_REPOSITORY -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
        throw "GITHUB_REPOSITORY must look like owner/repo (got '$($settings.GITHUB_REPOSITORY)')."
    }
    if ($settings.IMAGE_PREFIX -cnotmatch '^[a-z0-9./_-]+$') {
        throw "IMAGE_PREFIX must be lowercase, e.g. ghcr.io/yungkhann/hype-app (got '$($settings.IMAGE_PREFIX)')."
    }
    if ($settings.WEB_PORT -notmatch '^\d{2,5}$') { throw "WEB_PORT must be a port number." }
    if ($settings.PUBLIC_HOSTNAME -match '[/:]') {
        throw "PUBLIC_HOSTNAME is a bare host name such as lumvy.io (no https://, no path)."
    }
    return $settings
}

function Write-HypeLog {
    param([string]$Message, [ValidateSet('INFO', 'WARN', 'ERROR')][string]$Level = 'INFO', [string]$Name = 'deploy')
    $where = Get-HypePaths
    $line = "{0} [{1}] {2}" -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Level, $Message
    try {
        if (-not (Test-Path -LiteralPath $where.Logs)) { New-Item -ItemType Directory -Path $where.Logs -Force | Out-Null }
        $file = Join-Path $where.Logs ("{0}-{1}.log" -f $Name, (Get-Date).ToString('yyyyMMdd'))
        [IO.File]::AppendAllText($file, $line + [Environment]::NewLine)
    } catch { }
    Write-Host $line
}

function Remove-HypeOldLogs {
    param($Paths, [int]$KeepDays = 14)
    $limit = (Get-Date).AddDays(-$KeepDays)
    Get-ChildItem -LiteralPath $Paths.Logs -Filter '*.log' -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt $limit } | Remove-Item -Force -ErrorAction SilentlyContinue
}

# ---- JSON state files ----------------------------------------------------------------------------------------

function Write-HypeJson {
    param([string]$Path, $Value)
    $json = ConvertTo-Json -InputObject $Value -Depth 8
    $tmp = "$Path.tmp"
    [IO.File]::WriteAllText($tmp, $json, (New-Object Text.UTF8Encoding $false))
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Read-HypeJson {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try { return ([IO.File]::ReadAllText($Path) | ConvertFrom-Json) } catch { return $null }
}

function Get-HypeStateFile { param($Paths, [string]$Name) return (Join-Path $Paths.State "$Name.json") }

function Get-HypeFailures {
    param($Paths)
    $raw = Read-HypeJson -Path (Get-HypeStateFile $Paths 'failures')
    $table = @{}
    if ($raw) { foreach ($p in $raw.PSObject.Properties) { $table[$p.Name] = $p.Value } }
    return $table
}

function Set-HypeFailure {
    param($Paths, [string]$Sha, [string]$ErrorText, [int]$Attempts = -1)
    $table = Get-HypeFailures -Paths $Paths
    $before = 0
    if ($table.ContainsKey($Sha)) { $before = [int]$table[$Sha].attempts }
    if ($Attempts -lt 0) { $Attempts = $before + 1 }
    if ($ErrorText.Length -gt 500) { $ErrorText = $ErrorText.Substring(0, 500) }
    $table[$Sha] = [pscustomobject]@{ attempts = $Attempts; last = (Get-Date).ToUniversalTime().ToString('o'); error = $ErrorText }
    Write-HypeJson -Path (Get-HypeStateFile $Paths 'failures') -Value $table
}

function Clear-HypeFailure {
    param($Paths, [string]$Sha)
    $table = Get-HypeFailures -Paths $Paths
    if ($table.ContainsKey($Sha)) {
        $table.Remove($Sha)
        Write-HypeJson -Path (Get-HypeStateFile $Paths 'failures') -Value $table
    }
}

function Test-HypeRetryAllowed {
    # Pure policy: may a release that failed before be attempted again now? Backoff 5, 10, 15 ... minutes; give up
    # after MaxAttempts until a newer release appears or someone deploys it by hand with -Force.
    param($Failure, [int]$MaxAttempts, $Now = $null)
    if ($null -eq $Failure) { return $true }
    if ($null -eq $Now) { $Now = (Get-Date).ToUniversalTime() }
    $attempts = [int]$Failure.attempts
    if ($attempts -ge $MaxAttempts) { return $false }
    $last = ConvertTo-HypeUtc -Value $Failure.last
    return ($Now -ge $last.AddMinutes(5 * $attempts))
}

function ConvertTo-HypeUtc {
    # Timestamps in state files are ISO 8601 strings. Windows PowerShell 5.1 reads them back as strings, PowerShell 7
    # as DateTime; accept both.
    param($Value)
    if ($Value -is [datetime]) { return $Value.ToUniversalTime() }
    if ($Value -is [DateTimeOffset]) { return $Value.UtcDateTime }
    return [DateTimeOffset]::Parse([string]$Value, [Globalization.CultureInfo]::InvariantCulture).UtcDateTime
}

function Get-HypeAgeMinutes {
    param($Value)
    return ((Get-Date).ToUniversalTime() - (ConvertTo-HypeUtc -Value $Value)).TotalMinutes
}

function Write-HypeHeartbeat {
    param($Paths, [string]$Result, [string]$Detail = '')
    $value = [pscustomobject]@{ at = (Get-Date).ToString('o'); result = $Result; detail = $Detail; pid = $PID }
    try { Write-HypeJson -Path (Get-HypeStateFile $Paths 'heartbeat') -Value $value } catch { }
}

# ---- native commands -----------------------------------------------------------------------------------------

function Invoke-HypeNative {
    # Runs an executable, returns @{ Code; Output }. stderr is captured as text (Windows PowerShell would otherwise
    # turn docker's progress output into errors). Never pass secrets as arguments: use -InputText.
    param([string]$File, [string[]]$Arguments, [string]$InputText = '')
    $before = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($InputText -ne '') {
            $output = $InputText | & $File @Arguments 2>&1 | ForEach-Object { "$_" }
        } else {
            $output = & $File @Arguments 2>&1 | ForEach-Object { "$_" }
        }
        $code = $LASTEXITCODE
    } catch {
        $output = @($_.Exception.Message)
        $code = 9009
    } finally {
        $ErrorActionPreference = $before
    }
    return [pscustomobject]@{ Code = $code; Output = (@($output) -join "`n") }
}

# ---- Docker --------------------------------------------------------------------------------------------------

function Test-HypeDocker {
    $result = Invoke-HypeNative -File 'docker' -Arguments @('info', '--format', '{{.ServerVersion}}')
    return ($result.Code -eq 0 -and $result.Output -match '^\d')
}

function Wait-HypeDocker {
    # Docker Desktop starts with the Windows sign-in; after a reboot the engine can take a minute or two.
    param([int]$TimeoutSeconds = 45)
    if (Test-HypeDocker) { return $true }
    $isWindowsHost = ($env:OS -eq 'Windows_NT')
    if ($isWindowsHost -and -not (Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue)) {
        $exe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
        if (Test-Path -LiteralPath $exe) {
            Write-HypeLog "Docker Desktop is not running; starting it."
            Start-Process -FilePath $exe | Out-Null
        }
    }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 5
        if (Test-HypeDocker) { return $true }
    }
    return $false
}

function Get-HypeImageRefs {
    param($Config, [string]$Sha)
    return [pscustomobject]@{
        Web = "$($Config.IMAGE_PREFIX)-web:$Sha"
        Api = "$($Config.IMAGE_PREFIX)-api:$Sha"
    }
}

function Get-HypeContainerState {
    # "running healthy", "running starting", "exited", "" (missing)
    param([string]$Name)
    $r = Invoke-HypeNative -File 'docker' -Arguments @('inspect', '--format',
        '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}', $Name)
    if ($r.Code -ne 0) { return '' }
    return $r.Output.Trim()
}

function Get-HypeContainerImage {
    param([string]$Name)
    $r = Invoke-HypeNative -File 'docker' -Arguments @('inspect', '--format', '{{.Config.Image}}', $Name)
    if ($r.Code -ne 0) { return '' }
    return $r.Output.Trim()
}

function Invoke-HypeCompose {
    # docker compose for one release: its own compose file, the shared hype.env, and the release's images.
    param($Paths, $Config, $Release, [string[]]$Arguments)
    $compose = Join-Path (Join-Path $Paths.Releases $Release.sha) 'compose.prod.yml'
    if (-not (Test-Path -LiteralPath $compose)) { throw "Compose file for $($Release.sha) is missing: $compose" }
    $env:WEB_IMAGE = $Release.web_image
    $env:API_IMAGE = $Release.api_image
    $env:RELEASE_SHA = $Release.sha
    $env:HYPE_DATA_DIR = $Paths.Data
    $base = @('compose', '-p', $script:ProjectName, '--project-directory', $Paths.Root, '-f', $compose)
    if (Test-Path -LiteralPath $Paths.EnvFile) { $base += @('--env-file', $Paths.EnvFile) }
    return Invoke-HypeNative -File 'docker' -Arguments ($base + $Arguments)
}

function Save-HypeReleaseCompose {
    # The Compose file travels inside the API image, so each release deploys with the file from its own commit.
    param($Paths, $Release)
    $dir = Join-Path $Paths.Releases $Release.sha
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $target = Join-Path $dir 'compose.prod.yml'
    $name = 'hype-cqa-extract-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $created = Invoke-HypeNative -File 'docker' -Arguments @('create', '--name', $name, $Release.api_image)
    if ($created.Code -ne 0) { throw "docker create failed: $($created.Output)" }
    try {
        $copied = Invoke-HypeNative -File 'docker' -Arguments @('cp', "${name}:$($script:ComposePathInImage)", $target)
        if ($copied.Code -ne 0) { throw "Could not extract the Compose file from $($Release.api_image): $($copied.Output)" }
    } finally {
        Invoke-HypeNative -File 'docker' -Arguments @('rm', '-f', $name) | Out-Null
    }
    return $target
}

function Test-HypeImageRevision {
    param([string]$Image, [string]$Sha)
    # No double quotes in the template: Windows PowerShell 5.1 strips them from native command arguments.
    $r = Invoke-HypeNative -File 'docker' -Arguments @('image', 'inspect', '--format', '{{json .Config.Labels}}', $Image)
    if ($r.Code -ne 0) { return $false }
    $label = ''
    try {
        $labels = $r.Output.Trim() | ConvertFrom-Json
        if ($labels -and $labels.PSObject.Properties['org.opencontainers.image.revision']) {
            $label = [string]$labels.'org.opencontainers.image.revision'
        }
    } catch { return $false }
    # Images built without the label (local builds) are accepted; a label naming another commit is not.
    return ($label -eq '' -or $label -eq $Sha)
}

# ---- secrets (DPAPI, current Windows user) -------------------------------------------------------------------

function Protect-HypeSecretsDirectory {
    # Only this Windows user and SYSTEM may read the secrets folder (inherited permissions removed).
    param($Paths)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $r = Invoke-HypeNative -File 'icacls' -Arguments @($Paths.Secrets, '/inheritance:r', '/grant:r',
        "*${sid}:(OI)(CI)F", '*S-1-5-18:(OI)(CI)F')
    if ($r.Code -ne 0) { throw "icacls failed: $($r.Output)" }
}

function Save-HypeSecret {
    param($Paths, [ValidateSet('github-api', 'ghcr')][string]$Name, [Security.SecureString]$Value)
    $file = Join-Path $Paths.Secrets "$Name.dpapi"
    $encrypted = ConvertFrom-SecureString -SecureString $Value   # DPAPI: only this user on this PC can decrypt
    [IO.File]::WriteAllText($file, $encrypted, (New-Object Text.UTF8Encoding $false))
}

function Read-HypeSecret {
    param($Paths, [ValidateSet('github-api', 'ghcr')][string]$Name)
    $file = Join-Path $Paths.Secrets "$Name.dpapi"
    if (-not (Test-Path -LiteralPath $file)) { throw "Missing secret '$Name'. Run install.ps1 -SetTokens." }
    $secure = ConvertTo-SecureString -String ([IO.File]::ReadAllText($file).Trim())
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Connect-HypeRegistry {
    param($Paths, $Config)
    $registry = $Config.IMAGE_PREFIX.Split('/')[0]
    $token = Read-HypeSecret -Paths $Paths -Name 'ghcr'
    $r = Invoke-HypeNative -File 'docker' -Arguments @('login', $registry, '--username', $Config.GHCR_USERNAME,
        '--password-stdin') -InputText $token
    $token = $null
    if ($r.Code -ne 0) { throw (New-Object System.Net.WebException("docker login $registry failed (check the GHCR token and GHCR_USERNAME): $($r.Output)")) }
}

# ---- GitHub: which release is deployable ---------------------------------------------------------------------

function Invoke-HypeGitHub {
    param($Paths, [string]$PathAndQuery)
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $token = Read-HypeSecret -Paths $Paths -Name 'github-api'
    $headers = @{
        Authorization          = "Bearer $token"
        Accept                 = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = '2022-11-28'
        'User-Agent'           = 'hype-cqa-deploy-agent'
    }
    try {
        return Invoke-RestMethod -Uri ("https://api.github.com" + $PathAndQuery) -Headers $headers -TimeoutSec 20 -Method Get -UseBasicParsing
    } catch {
        $status = ''
        if ($_.Exception.PSObject.Properties['Response'] -and $_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        throw (New-Object System.Net.WebException("GitHub API request failed ($status): $($_.Exception.Message)"))
    } finally {
        $token = $null
        $headers = $null
    }
}

function Select-HypeRelease {
    # Pure function: from GitHub workflow runs (newest first), pick the newest run that is a complete, successful
    # release of the production branch. A run only succeeds after CI passed, both images were pushed with the same
    # commit SHA tag, and the pushed pair passed the verification job, so a successful run IS a complete release.
    param([object[]]$Runs, [string]$Repository, [string]$Branch, [string]$Workflow)
    foreach ($run in @($Runs)) {
        if ($null -eq $run) { continue }
        if ($run.status -ne 'completed' -or $run.conclusion -ne 'success') { continue }
        if ($run.event -ne 'push' -or $run.head_branch -ne $Branch) { continue }
        if ([string]$run.head_sha -cnotmatch '^[0-9a-f]{40}$') { continue }
        if ($run.PSObject.Properties['path'] -and $run.path -and -not ([string]$run.path).EndsWith($Workflow)) { continue }
        if ($run.PSObject.Properties['head_repository'] -and $run.head_repository -and
            $run.head_repository.full_name -ne $Repository) { continue }
        return [pscustomobject]@{
            sha        = [string]$run.head_sha
            run_id     = $run.id
            run_number = [int]$run.run_number
            created_at = $run.created_at
            url        = $run.html_url
        }
    }
    return $null
}

function Get-HypeLatestRelease {
    param($Paths, $Config)
    $query = "/repos/$($Config.GITHUB_REPOSITORY)/actions/workflows/$($Config.RELEASE_WORKFLOW)/runs" +
             "?branch=$($Config.RELEASE_BRANCH)&event=push&status=success&per_page=20&exclude_pull_requests=true"
    $response = Invoke-HypeGitHub -Paths $Paths -PathAndQuery $query
    return Select-HypeRelease -Runs @($response.workflow_runs) -Repository $Config.GITHUB_REPOSITORY `
        -Branch $Config.RELEASE_BRANCH -Workflow $Config.RELEASE_WORKFLOW
}

function Get-HypeReleaseForSha {
    param($Paths, $Config, [string]$Sha)
    $query = "/repos/$($Config.GITHUB_REPOSITORY)/actions/workflows/$($Config.RELEASE_WORKFLOW)/runs" +
             "?head_sha=$Sha&status=success&per_page=10"
    $response = Invoke-HypeGitHub -Paths $Paths -PathAndQuery $query
    return Select-HypeRelease -Runs @($response.workflow_runs) -Repository $Config.GITHUB_REPOSITORY `
        -Branch $Config.RELEASE_BRANCH -Workflow $Config.RELEASE_WORKFLOW
}

# ---- health --------------------------------------------------------------------------------------------------

function Invoke-HypeHttp {
    # GET with System.Net.Http (works in Windows PowerShell 5.1 and PowerShell 7, can set Host, ignores proxies).
    param([string]$Url, [int]$TimeoutSec = 5, [string]$HostHeader = '')
    Add-Type -AssemblyName System.Net.Http
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.UseProxy = $false
    $handler.AllowAutoRedirect = $false
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)
    try {
        $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, $Url)
        if ($HostHeader) { $request.Headers.Host = $HostHeader }
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        return [pscustomobject]@{ Status = [int]$response.StatusCode; Body = [string]$body }
    } catch {
        $message = $_.Exception.Message
        if ($_.Exception.InnerException) { $message = $_.Exception.InnerException.Message }
        return [pscustomobject]@{ Status = 0; Body = $message }
    } finally {
        $client.Dispose()
    }
}

function Test-HypeAppHealth {
    # What a browser depends on. The model is deliberately NOT part of this: the site stays up without it.
    param($Config, [string]$ExpectRelease = '')
    $base = "http://127.0.0.1:$($Config.WEB_PORT)"
    $problems = @()
    $web = Invoke-HypeHttp -Url "$base/healthz"
    if ($web.Status -ne 200) { $problems += "web /healthz -> $($web.Status) $($web.Body)" }
    elseif ($ExpectRelease -and $web.Body -notmatch [regex]::Escape($ExpectRelease)) {
        $problems += "web does not serve release $ExpectRelease ($($web.Body))"
    }
    $page = Invoke-HypeHttp -Url "$base/"
    if ($page.Status -ne 200 -or $page.Body -notmatch '<html') { $problems += "frontend / -> $($page.Status)" }
    $api = Invoke-HypeHttp -Url "$base/api/v1/health"
    if ($api.Status -ne 200 -or $api.Body -notmatch '"ok"') { $problems += "API through the proxy /api/v1/health -> $($api.Status)" }
    $cqa = Invoke-HypeHttp -Url "$base/api/v1/cqa/conversations?page_size=1"
    if ($cqa.Status -ne 200) { $problems += "CQA store /api/v1/cqa/conversations -> $($cqa.Status)" }
    return $problems
}

function Test-HypePublicHost {
    # The API's DNS-rebinding guard must accept the public host name, or every API call via Cloudflare gets 400.
    param($Config)
    if (-not $Config.PUBLIC_HOSTNAME) { return 'PUBLIC_HOSTNAME is not set in hype.env (API calls through the tunnel will be refused).' }
    $r = Invoke-HypeHttp -Url "http://127.0.0.1:$($Config.WEB_PORT)/api/v1/health" -HostHeader $Config.PUBLIC_HOSTNAME
    if ($r.Status -eq 200) { return '' }
    return "The API answers $($r.Status) for Host '$($Config.PUBLIC_HOSTNAME)'; check PUBLIC_HOSTNAME in hype.env."
}

function Wait-HypeAppHealth {
    param($Config, [string]$ExpectRelease = '', [int]$TimeoutSeconds = 90)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $problems = @(Test-HypeAppHealth -Config $Config -ExpectRelease $ExpectRelease)
        if ($problems.Count -eq 0) { return @() }
        Start-Sleep -Seconds 3
    } while ((Get-Date) -lt $deadline)
    return $problems
}

# ---- backups -------------------------------------------------------------------------------------------------

function Backup-HypeData {
    # Copies data\ to backups\<timestamp>-<reason>-<sha8>. robocopy exit codes below 8 mean success.
    param($Paths, [string]$Reason, [string]$Sha = 'none', [int]$Keep = 20)
    $label = $Sha
    if ($Sha.Length -ge 8) { $label = $Sha.Substring(0, 8) }
    $name = '{0}-{1}-{2}' -f (Get-Date).ToString('yyyyMMdd-HHmmss'), $Reason, $label
    $target = Join-Path $Paths.Backups $name
    $r = Invoke-HypeNative -File 'robocopy' -Arguments @($Paths.Data, $target, '/E', '/COPY:DAT', '/R:2', '/W:2',
        '/XF', '.tmp-*', '/NFL', '/NDL', '/NP', '/NJH')
    if ($r.Code -ge 8) { throw "Backup to $target failed (robocopy $($r.Code)): $($r.Output)" }
    # Retention per reason, oldest first; only folders this function created are touched.
    $pattern = '^\d{8}-\d{6}-' + [regex]::Escape($Reason) + '-'
    $old = @(Get-ChildItem -LiteralPath $Paths.Backups -Directory | Where-Object { $_.Name -match $pattern } |
             Sort-Object Name -Descending | Select-Object -Skip $Keep)
    foreach ($dir in $old) { Remove-Item -LiteralPath $dir.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    return $target
}

# ---- deployment ----------------------------------------------------------------------------------------------

function New-HypeReleaseRecord {
    param($Config, [string]$Sha, $Meta = $null)
    $refs = Get-HypeImageRefs -Config $Config -Sha $Sha
    $record = [ordered]@{ sha = $Sha; web_image = $refs.Web; api_image = $refs.Api; run_id = $null; run_number = 0; url = $null }
    if ($Meta) {
        $record.run_id = $Meta.run_id
        $record.run_number = [int]$Meta.run_number
        $record.url = $Meta.url
    }
    return [pscustomobject]$record
}

function Get-HypeCurrent { param($Paths) return Read-HypeJson -Path (Get-HypeStateFile $Paths 'current') }

function Start-HypeRelease {
    # Brings the stack to $Release and checks it. Throws on failure; does not roll back.
    param($Paths, $Config, $Release)
    $timeout = [int]$Config.DEPLOY_HEALTH_TIMEOUT_S
    $up = Invoke-HypeCompose -Paths $Paths -Config $Config -Release $Release -Arguments @(
        'up', '-d', '--remove-orphans', '--wait', '--wait-timeout', "$timeout")
    if ($up.Code -ne 0) { throw "docker compose up failed: $($up.Output)" }
    $problems = @(Wait-HypeAppHealth -Config $Config -ExpectRelease $Release.sha -TimeoutSeconds ([int]$Config.APP_HEALTH_TIMEOUT_S))
    if ($problems.Count -gt 0) { throw ("health checks failed: " + ($problems -join '; ')) }
}

function Invoke-HypeDeploy {
    # Deploys one release with best-effort rollback. Returns $true on success, $false when the release failed (and
    # the previous one was restored if there was one). Throws System.Net.WebException for transient problems found
    # before anything running was touched (registry login, image pull), so the caller can simply retry later.
    # Downtime: the API restarts (typically 5-20 s). This is not zero-downtime: one machine, one API process.
    param($Paths, $Config, $Release, [switch]$CountFailure)
    $current = Get-HypeCurrent -Paths $Paths
    $over = ''
    if ($current) { $over = " over $($current.sha)" }
    Write-HypeLog "Deploying $($Release.sha) (run #$($Release.run_number))$over."

    # 1. Fetch everything first. Nothing running is touched until both images and the compose file are here.
    #    If GHCR or the network is down, images already on this PC (e.g. for a rollback) are used as they are.
    $loginError = ''
    try { Connect-HypeRegistry -Paths $Paths -Config $Config } catch { $loginError = $_.Exception.Message }
    foreach ($image in @($Release.web_image, $Release.api_image)) {
        $pull = Invoke-HypeNative -File 'docker' -Arguments @('pull', '--quiet', $image)
        if ($pull.Code -ne 0) {
            $local = Invoke-HypeNative -File 'docker' -Arguments @('image', 'inspect', '--format', '{{.Id}}', $image)
            if ($local.Code -ne 0) {
                throw (New-Object System.Net.WebException("pull failed for ${image}: $($pull.Output) $loginError".Trim()))
            }
            Write-HypeLog "Could not pull $image; using the copy already on this PC." 'WARN'
        }
    }
    try {
        foreach ($image in @($Release.web_image, $Release.api_image)) {
            if (-not (Test-HypeImageRevision -Image $image -Sha $Release.sha)) {
                throw "Image $image is labelled with another commit than $($Release.sha)."
            }
        }
        Save-HypeReleaseCompose -Paths $Paths -Release $Release | Out-Null
        $validation = Invoke-HypeCompose -Paths $Paths -Config $Config -Release $Release -Arguments @('config', '--quiet')
        if ($validation.Code -ne 0) { throw "The release's Compose file does not validate with hype.env: $($validation.Output)" }
    } catch {
        Write-HypeLog "Release $($Release.sha) rejected before switching: $($_.Exception.Message)" 'ERROR'
        if ($CountFailure) { Set-HypeFailure -Paths $Paths -Sha $Release.sha -ErrorText $_.Exception.Message }
        return $false
    }

    # 2. Consistent data snapshot: stop the API (it finishes requests and writes), copy data\, then switch.
    if (Get-HypeContainerState -Name $script:ApiContainer) {
        Invoke-HypeNative -File 'docker' -Arguments @('stop', '-t', '30', $script:ApiContainer) | Out-Null
    }
    $from = 'none'
    if ($current) { $from = $current.sha }
    try {
        $backup = Backup-HypeData -Paths $Paths -Reason 'predeploy' -Sha $from -Keep ([int]$Config.BACKUP_KEEP)
        Write-HypeLog "Data snapshot: $backup"
    } catch {
        Write-HypeLog "Backup failed; deployment aborted; restarting the current release. $($_.Exception.Message)" 'ERROR'
        if ($current) { Invoke-HypeCompose -Paths $Paths -Config $Config -Release $current -Arguments @('up', '-d') | Out-Null }
        return $false
    }

    # 3. Switch and verify; on failure restore the previous images (never older data).
    try {
        Start-HypeRelease -Paths $Paths -Config $Config -Release $Release
    } catch {
        $reason = $_.Exception.Message
        Write-HypeLog "Release $($Release.sha) failed: $reason" 'ERROR'
        $logs = Invoke-HypeCompose -Paths $Paths -Config $Config -Release $Release -Arguments @('logs', '--no-color', '--tail', '60')
        Write-HypeLog ("Container logs of the failed release:`n" + $logs.Output) 'ERROR'
        if ($CountFailure) { Set-HypeFailure -Paths $Paths -Sha $Release.sha -ErrorText $reason }
        if ($current) {
            Write-HypeLog "Rolling back to $($current.sha). Data stays as it is (no restore over newer data)." 'WARN'
            try {
                Start-HypeRelease -Paths $Paths -Config $Config -Release $current
                Write-HypeLog "Rollback to $($current.sha) is healthy." 'WARN'
            } catch {
                Write-HypeLog "ROLLBACK FAILED: $($_.Exception.Message). Run healthcheck.ps1; see docs/WINDOWS_SETUP.md." 'ERROR'
            }
        } else {
            Write-HypeLog "No earlier release to roll back to." 'ERROR'
        }
        return $false
    }

    # 4. Record.
    if ($current -and $current.sha -ne $Release.sha) { Write-HypeJson -Path (Get-HypeStateFile $Paths 'previous') -Value $current }
    $Release | Add-Member -NotePropertyName deployed_at -NotePropertyValue (Get-Date).ToString('o') -Force
    Write-HypeJson -Path (Get-HypeStateFile $Paths 'current') -Value $Release
    [IO.File]::AppendAllText((Join-Path $Paths.State 'history.jsonl'),
        (ConvertTo-Json -InputObject $Release -Compress -Depth 4) + [Environment]::NewLine)
    Clear-HypeFailure -Paths $Paths -Sha $Release.sha
    Write-HypeLog "Deployed $($Release.sha). http://127.0.0.1:$($Config.WEB_PORT) is healthy."
    $warning = Test-HypePublicHost -Config $Config
    if ($warning) { Write-HypeLog $warning 'WARN' }
    Remove-HypeOldImages -Paths $Paths -Config $Config
    return $true
}

function Remove-HypeOldImages {
    # Keeps the current and previous release plus the last IMAGES_KEEP deployed ones; removes other release images.
    param($Paths, $Config)
    $keep = @{}
    foreach ($name in @('current', 'previous')) {
        $r = Read-HypeJson -Path (Get-HypeStateFile $Paths $name)
        if ($r) { $keep[$r.sha] = $true }
    }
    $history = Join-Path $Paths.State 'history.jsonl'
    if (Test-Path -LiteralPath $history) {
        $lines = @([IO.File]::ReadAllLines($history) | Where-Object { $_.Trim() } | Select-Object -Last ([int]$Config.IMAGES_KEEP))
        foreach ($line in $lines) { try { $keep[($line | ConvertFrom-Json).sha] = $true } catch { } }
    }
    foreach ($suffix in @('web', 'api')) {
        $repo = "$($Config.IMAGE_PREFIX)-$suffix"
        $list = Invoke-HypeNative -File 'docker' -Arguments @('images', $repo, '--format', '{{.Tag}}')
        if ($list.Code -ne 0) { continue }
        foreach ($tag in ($list.Output -split "`n")) {
            $tag = $tag.Trim()
            if ($tag -match '^[0-9a-f]{40}$' -and -not $keep.ContainsKey($tag)) {
                Invoke-HypeNative -File 'docker' -Arguments @('image', 'rm', "${repo}:$tag") | Out-Null
            }
        }
    }
}

# ---- single-instance lock ------------------------------------------------------------------------------------

function Enter-HypeLock {
    # An exclusive handle on state\deploy.lock. Windows releases it when the process exits, even after a crash.
    param($Paths)
    try {
        return [IO.File]::Open($Paths.Lock, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch [System.IO.IOException] {
        return $null
    }
}

Export-ModuleMember -Function *-Hype*
