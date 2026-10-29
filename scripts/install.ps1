[CmdletBinding()]
param(
    [switch]$Service,
    [switch]$Plain,
    [switch]$Uninstall,
    [switch]$DryRun,
    [string[]]$AllowHost = @(),
    [string]$Owner
)

$ErrorActionPreference = 'Stop'
$TaskName = 'omp-console'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$StateDir = Join-Path $env:USERPROFILE '.omp-console'
$EnvFile = Join-Path $StateDir 'env'
$ServiceConfig = Join-Path $StateDir 'windows-service.json'
$BinDirectory = Join-Path $env:USERPROFILE '.local\bin'
$CliShim = Join-Path $BinDirectory 'omp-console.cmd'
$RunnerScript = Join-Path $RepoRoot 'scripts\windows\run-daemon.ps1'
$DaemonEntry = Join-Path $RepoRoot 'packages\daemon\src\main.ts'
$WebDirectory = Join-Path $RepoRoot 'packages\web\dist'
$Taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
$Icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'

function Test-PathEntry([string]$Entry, [string]$Target) {
    if ([string]::IsNullOrWhiteSpace($Entry)) { return $false }
    $left = [Environment]::ExpandEnvironmentVariables($Entry.Trim().Trim('"'))
    $right = [Environment]::ExpandEnvironmentVariables($Target.Trim().Trim('"'))
    try { $left = [IO.Path]::GetFullPath($left).TrimEnd('\', '/') } catch { }
    try { $right = [IO.Path]::GetFullPath($right).TrimEnd('\', '/') } catch { }
    return [string]::Equals($left, $right, [StringComparison]::OrdinalIgnoreCase)
}

function Invoke-Native([string]$Executable, [string[]]$Arguments, [string]$Description) {
    & $Executable @Arguments
    $code = $LASTEXITCODE
    if ($code -ne 0) { throw "$Description failed with exit code $code." }
}

function Write-AtomicText([string]$Path, [string]$Text) {
    $directory = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $temporary = Join-Path $directory ('.' + [IO.Path]::GetFileName($Path) + '.' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $encoding = New-Object System.Text.UTF8Encoding($false)
    try {
        [IO.File]::WriteAllText($temporary, $Text, $encoding)
        if (Test-Path -LiteralPath $Path) {
            $existing = Get-Item -LiteralPath $Path -Force
            if (($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing to replace a reparse point: $Path"
            }
            # [NullString]::Value: PowerShell passes $null to a .NET string parameter as "", which Replace rejects.
            [IO.File]::Replace($temporary, $Path, [NullString]::Value)
        } else {
            [IO.File]::Move($temporary, $Path)
        }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Set-StateDirectoryAcl {
    if (-not (Test-Path -LiteralPath $StateDir -PathType Container)) {
        New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
    }
    $directory = Get-Item -LiteralPath $StateDir -Force
    if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to use a junction or symbolic link as the state directory: $StateDir"
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $userAce = '*' + $identity.User.Value + ':(OI)(CI)F'
    $systemAce = '*S-1-5-18:(OI)(CI)F'
    # The folder gets explicit, inheritable entries for the user and SYSTEM and stops inheriting from its parent; its
    # contents are then reset to inherit only those entries. Granting (OI)(CI) entries with /T does not land on files,
    # so removing inheritance recursively left existing files (the env file) with an empty ACL nobody could open.
    Invoke-Native $Icacls @($StateDir, '/reset') 'Resetting the state-directory ACL'
    Invoke-Native $Icacls @($StateDir, '/grant:r', $userAce, $systemAce) 'Granting state-directory access'
    Invoke-Native $Icacls @($StateDir, '/inheritance:r') 'Removing inherited state-directory ACLs'
    if (Get-ChildItem -LiteralPath $StateDir -Force | Select-Object -First 1) {
        Invoke-Native $Icacls @((Join-Path $StateDir '*'), '/reset', '/T', '/C') 'Resetting state-file ACLs to the folder''s entries'
    }
}

function Add-UserPathEntry([string]$PathEntry) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = New-Object 'System.Collections.Generic.List[string]'
    foreach ($entry in ($userPath -split ';')) {
        if ([string]::IsNullOrWhiteSpace($entry)) { continue }
        if (Test-PathEntry $entry $PathEntry) { continue }
        $entries.Add($entry)
    }
    $entries.Add($PathEntry)
    [Environment]::SetEnvironmentVariable('Path', [string]::Join(';', $entries.ToArray()), 'User')
    if (-not (@($env:Path -split ';' | Where-Object { Test-PathEntry $_ $PathEntry }).Count -gt 0)) {
        $env:Path = $PathEntry + ';' + $env:Path
    }
}

function Stop-MatchingProcesses {
    $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
    foreach ($process in $processes) {
        $commandLine = [string]$process.CommandLine
        if ([string]::IsNullOrEmpty($commandLine)) { continue }
        $isRunner = $commandLine.IndexOf($RunnerScript, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
            $commandLine.IndexOf($RepoRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
        $isDaemon = $commandLine.IndexOf($DaemonEntry, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
            $commandLine.IndexOf($StateDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
            $commandLine.IndexOf('--port 7490', [StringComparison]::OrdinalIgnoreCase) -ge 0
        if (-not ($isRunner -or $isDaemon)) { continue }
        Write-Host ("Stopping omp-console process tree PID {0}" -f $process.ProcessId)
        & $Taskkill /PID $process.ProcessId /T /F | Out-Null
        $code = $LASTEXITCODE
        if ($code -ne 0 -and (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue)) {
            throw "Could not stop omp-console process tree PID $($process.ProcessId) (taskkill exit $code)."
        }
    }
}

function Stop-ExistingService {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -ne $task -and $task.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        do {
            Start-Sleep -Milliseconds 250
            $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        } while ($null -ne $task -and $task.State -eq 'Running' -and [DateTime]::UtcNow -lt $deadline)
    }
    Stop-MatchingProcesses
}

function New-StartCommand([string]$BunPath) {
    $quote = { param([string]$Value) "'" + $Value.Replace("'", "''") + "'" }
    $command = '& ' + (& $quote $BunPath) + ' ' + (& $quote $DaemonEntry) +
        ' --port 7490 --state-dir ' + (& $quote $StateDir) + ' --web-dir ' + (& $quote $WebDirectory)
    foreach ($hostName in $AllowHost) { $command += ' --allow-host ' + (& $quote $hostName) }
    if (-not [string]::IsNullOrWhiteSpace($Owner)) { $command += ' --owner ' + (& $quote $Owner) }
    return $command
}

function Get-RequiredBun {
    $command = Get-Command -Name 'bun.exe', 'bun' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command) {
        throw 'Bun >= 1.4 is required. Install it with: powershell -c "irm bun.sh/install.ps1 | iex"'
    }
    $path = $command.Source
    $versionOutput = & $path --version 2>&1
    $versionExit = $LASTEXITCODE
    $versionText = (($versionOutput | Select-Object -First 1) -as [string]).Trim()
    $match = [regex]::Match($versionText, '^([0-9]+)\.([0-9]+)(?:\.[0-9]+)?')
    if ($versionExit -ne 0 -or -not $match.Success) {
        throw "Could not read Bun version from '$path --version'. Install Bun 1.4 or newer with: powershell -c `"irm bun.sh/install.ps1 | iex`""
    }
    $version = [Version]::Parse($match.Groups[1].Value + '.' + $match.Groups[2].Value)
    if ($version -lt [Version]'1.4') {
        throw "Bun 1.4 or newer is required; found $versionText. Upgrade with: powershell -c `"irm bun.sh/install.ps1 | iex`""
    }
    # Package scripts invoke `bun` by name; make it resolve to the executable whose version was checked.
    $bunDirectory = Split-Path -Parent $path
    $pathEntries = @($env:Path -split ';')
    if ($pathEntries.Count -eq 0 -or -not (Test-PathEntry $pathEntries[0] $bunDirectory)) {
        $env:Path = $bunDirectory + ';' + $env:Path
    }
    Write-Host "Bun $versionText at $path."
    return $path
}

function Get-RequiredOmp {
    $command = Get-Command -Name 'omp.exe', 'omp.cmd', 'omp' -All -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandType -eq [Management.Automation.CommandTypes]::Application } |
        Select-Object -First 1
    if ($null -eq $command) { throw 'omp is required. Install omp, open a new PowerShell window, then rerun this installer.' }
    $versionOutput = & $command.Source --version 2>&1
    $versionExit = $LASTEXITCODE
    if ($versionExit -ne 0) { throw "The omp command '$($command.Source)' did not pass 'omp --version'." }
    Write-Host ("omp: {0}" -f (($versionOutput | Select-Object -First 1) -as [string]).Trim())
    return $command.Source
}

function Invoke-Bun([string]$BunPath, [string[]]$Arguments, [string]$WorkingDirectory, [string]$Description) {
    Push-Location -LiteralPath $WorkingDirectory
    try { Invoke-Native $BunPath $Arguments $Description } finally { Pop-Location }
}

function Initialize-State {
    Set-StateDirectoryAcl
    if (Test-Path -LiteralPath $EnvFile) {
        $item = Get-Item -LiteralPath $EnvFile -Force
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing to use a non-regular or reparse-point environment file: $EnvFile"
        }
    } else {
        Write-AtomicText $EnvFile "# Optional daemon environment. Use literal KEY=value lines.`n# Add provider keys yourself; this installer never reads or writes credentials.`n"
    }
}

function Write-CliShim([string]$BunPath) {
    New-Item -ItemType Directory -Path $BinDirectory -Force | Out-Null
    $lines = @(
        '@echo off',
        '@setlocal DisableDelayedExpansion',
        '@chcp 65001 >nul',
        ('"' + $BunPath + '" "' + $DaemonEntry + '" %*')
    )
    Write-AtomicText $CliShim (($lines -join "`r`n") + "`r`n")
    Add-UserPathEntry $BinDirectory
}

function Register-Service([string]$BunPath) {
    $hostValues = @($AllowHost)
    $config = [ordered]@{
        BunPath = $BunPath
        AllowHost = $hostValues
        Owner = $Owner
    }
    Write-AtomicText $ServiceConfig (($config | ConvertTo-Json -Depth 4) + "`n")
    Stop-ExistingService
    $powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $actionArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $RunnerScript + '"'
    $action = New-ScheduledTaskAction -Execute $powerShell -Argument $actionArguments
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
        -Settings $settings -Description 'Runs the omp-console daemon for the installing user.' -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
}

if ($Service -and $Plain) { throw '-Service and -Plain cannot be combined.' }
if ($Uninstall -and ($Plain -or $AllowHost.Count -gt 0 -or -not [string]::IsNullOrWhiteSpace($Owner))) {
    throw '-Uninstall cannot be combined with -Plain, -AllowHost, or -Owner.'
}
if ($Owner -and $AllowHost.Count -eq 0) { throw '-Owner only applies with -AllowHost; pass at least one allowed host.' }
if ($Plain -and ($AllowHost.Count -gt 0 -or -not [string]::IsNullOrWhiteSpace($Owner))) {
    throw '-AllowHost and -Owner require the scheduled service; they cannot be used with -Plain.'
}

if ($Uninstall) {
    if ($DryRun) {
        Write-Host "Would stop Scheduled Task '$TaskName', terminate only omp-console process trees for this checkout, unregister the task, and remove this checkout's CLI shim. State and repository stay at $StateDir and $RepoRoot."
        exit 0
    }
    Stop-ExistingService
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -ne $task) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
    if (Test-Path -LiteralPath $CliShim -PathType Leaf) {
        $contents = [IO.File]::ReadAllText($CliShim)
        if ($contents.IndexOf($DaemonEntry, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            Remove-Item -LiteralPath $CliShim -Force
        } else {
            Write-Warning "Left unrelated CLI shim untouched: $CliShim"
        }
    }
    Write-Host "Removed the omp-console scheduled task and this checkout's CLI shim. State and repository remain in place."
    exit 0
}

if (-not $Plain) { $Service = $true }
$BunPath = Get-RequiredBun
$OmpPath = Get-RequiredOmp
$startCommand = New-StartCommand $BunPath

if ($DryRun) {
    Write-Host "Would run: (cd '$RepoRoot' && '$BunPath' install --frozen-lockfile)"
    Write-Host "Would run: (cd '$RepoRoot\packages\web' && '$BunPath' run build)"
    Write-Host "Would create $StateDir with inherited ACLs removed and full control for only the current user and SYSTEM; create a commented env template without credentials; atomically write $CliShim and add $BinDirectory to the user PATH."
    if ($Service) {
        Write-Host "Would stop the existing '$TaskName' task and matching daemon process tree, register a per-user at-logon task, start it, and wait for http://127.0.0.1:7490/api/pair/status."
        Write-Host "Would use daemon logs at $env:LOCALAPPDATA\omp-console\logs\daemon.log."
    } else {
        Write-Host 'Would not register or start a background service.'
    }
    Write-Host 'Exact daemon start command:'
    Write-Host $startCommand
    if ($Service) { Write-Host 'After the service responds, run omp-console open in an interactive PowerShell window.' }
    exit 0
}

Invoke-Bun $BunPath @('install', '--frozen-lockfile') $RepoRoot 'bun install --frozen-lockfile'
Invoke-Bun $BunPath @('run', 'build') (Join-Path $RepoRoot 'packages\web') 'web build'
Initialize-State
Write-CliShim $BunPath

if ($Plain) {
    Write-Host 'Build and CLI installation complete. Start the daemon with this exact PowerShell command:'
    Write-Host $startCommand
    Write-Host 'Then run: omp-console open'
    exit 0
}

Register-Service $BunPath
$deadline = [DateTime]::UtcNow.AddSeconds(45)
$ready = $false
$lastError = $null
do {
    try {
        $response = Invoke-WebRequest -Uri 'http://127.0.0.1:7490/api/pair/status' -Method Get -UseBasicParsing -TimeoutSec 3
        if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch {
        $lastError = $_.Exception.Message
    }
    Start-Sleep -Seconds 1
} while ([DateTime]::UtcNow -lt $deadline)
if (-not $ready) {
    throw "omp-console did not answer /api/pair/status within 45 seconds. Check 'omp-console logs' at $env:LOCALAPPDATA\omp-console\logs\daemon.log. Last request error: $lastError"
}
Write-Host 'omp-console is responding at http://127.0.0.1:7490.'
if (-not [Console]::IsOutputRedirected) {
    & $CliShim open
    if ($LASTEXITCODE -ne 0) { Write-Warning "Could not open the pairing page automatically. Run 'omp-console open' in PowerShell." }
} else {
    Write-Host "Next, run 'omp-console open' in PowerShell to pair a browser."
}
