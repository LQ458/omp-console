[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$StateDir = Join-Path $env:USERPROFILE '.omp-console'
$ConfigPath = Join-Path $StateDir 'windows-service.json'
$LogDirectory = Join-Path $env:LOCALAPPDATA 'omp-console\logs'
$LogPath = Join-Path $LogDirectory 'daemon.log'
$OldLogPath = Join-Path $LogDirectory 'daemon.log.old'
$DaemonEntry = Join-Path $RepoRoot 'packages\daemon\src\main.ts'
$WebDirectory = Join-Path $RepoRoot 'packages\web\dist'
$Taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
$LogLimit = 10MB
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$Child = $null

function Write-RunnerLog([string]$Message) {
    if (-not (Test-Path -LiteralPath $LogDirectory -PathType Container)) {
        New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
    }
    $line = '{0} {1}{2}' -f [DateTime]::Now.ToString('yyyy-MM-ddTHH:mm:ss.fffK'), $Message, "`r`n"
    $lineBytes = $Utf8NoBom.GetByteCount($line)
    if ((Test-Path -LiteralPath $LogPath -PathType Leaf) -and ((Get-Item -LiteralPath $LogPath).Length + $lineBytes -gt $LogLimit)) {
        if (Test-Path -LiteralPath $OldLogPath) { Remove-Item -LiteralPath $OldLogPath -Force }
        Move-Item -LiteralPath $LogPath -Destination $OldLogPath -Force
    }
    [IO.File]::AppendAllText($LogPath, $line, $Utf8NoBom)
}

function Quote-ProcessArgument([string]$Value) {
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $slashes++
        } elseif ($character -eq '"') {
            [void]$builder.Append(('\' * (2 * $slashes + 1)))
            [void]$builder.Append('"')
            $slashes = 0
        } else {
            if ($slashes -gt 0) { [void]$builder.Append(('\' * $slashes)) }
            [void]$builder.Append($character)
            $slashes = 0
        }
    }
    if ($slashes -gt 0) { [void]$builder.Append(('\' * (2 * $slashes))) }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Stop-ChildTree {
    if ($null -eq $script:Child) { return }
    try {
        if (-not $script:Child.HasExited) {
            Write-RunnerLog "Stopping daemon process tree PID $($script:Child.Id)."
            & $Taskkill /PID $script:Child.Id /T /F | Out-Null
            $script:Child.WaitForExit(10000) | Out-Null
        }
    } catch {
        try { Write-RunnerLog "Could not stop daemon process tree: $($_.Exception.Message)" } catch { }
    }
}

try {
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        throw "Missing service configuration: $ConfigPath. Rerun scripts/install.ps1 -Service."
    }
    $configuration = [IO.File]::ReadAllText($ConfigPath) | ConvertFrom-Json
    $BunPath = [string]$configuration.BunPath
    if ([string]::IsNullOrWhiteSpace($BunPath) -or -not (Test-Path -LiteralPath $BunPath -PathType Leaf)) {
        throw "The configured Bun executable is missing: $BunPath. Rerun scripts/install.ps1 -Service."
    }
    if (-not (Test-Path -LiteralPath $DaemonEntry -PathType Leaf)) { throw "Daemon entry is missing: $DaemonEntry" }
    if (-not (Test-Path -LiteralPath $WebDirectory -PathType Container)) { throw "Web build is missing: $WebDirectory" }
    if (-not (Test-Path -LiteralPath $LogDirectory -PathType Container)) {
        New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
    }
    Write-RunnerLog "Runner started for $RepoRoot."

    $retrySeconds = 1
    while ($true) {
        $argumentValues = @($DaemonEntry, '--port', '7490', '--state-dir', $StateDir, '--web-dir', $WebDirectory)
        foreach ($hostName in @($configuration.AllowHost)) {
            if (-not [string]::IsNullOrWhiteSpace([string]$hostName)) {
                $argumentValues += @('--allow-host', [string]$hostName)
            }
        }
        if (-not [string]::IsNullOrWhiteSpace([string]$configuration.Owner)) {
            $argumentValues += @('--owner', [string]$configuration.Owner)
        }
        $processArguments = (@($argumentValues | ForEach-Object { Quote-ProcessArgument ([string]$_) })) -join ' '
        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = $BunPath
        $startInfo.Arguments = $processArguments
        $startInfo.WorkingDirectory = $RepoRoot
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $startInfo.EnvironmentVariables['OMP_CONSOLE_SUPERVISED'] = '1'
        # The daemon stops itself when this runner is gone (Stop-ScheduledTask ends the runner without its finally).
        $startInfo.EnvironmentVariables['OMP_CONSOLE_PARENT_PID'] = [string]$PID

        $script:Child = New-Object System.Diagnostics.Process
        $script:Child.StartInfo = $startInfo
        if (-not $script:Child.Start()) { throw 'Could not start the daemon process.' }
        $startedAt = [DateTime]::UtcNow
        Write-RunnerLog "Started daemon PID $($script:Child.Id)."
        $stdout = $script:Child.StandardOutput.ReadLineAsync()
        $stderr = $script:Child.StandardError.ReadLineAsync()
        while ($true) {
            if ($null -ne $stdout -and $stdout.IsCompleted) {
                $line = $stdout.GetAwaiter().GetResult()
                if ($null -eq $line) { $stdout = $null } else {
                    Write-RunnerLog "OUT $line"
                    $stdout = $script:Child.StandardOutput.ReadLineAsync()
                }
            }
            if ($null -ne $stderr -and $stderr.IsCompleted) {
                $line = $stderr.GetAwaiter().GetResult()
                if ($null -eq $line) { $stderr = $null } else {
                    Write-RunnerLog "ERR $line"
                    $stderr = $script:Child.StandardError.ReadLineAsync()
                }
            }
            if ($script:Child.HasExited -and $null -eq $stdout -and $null -eq $stderr) { break }
            $pending = @()
            if ($null -ne $stdout) { $pending += $stdout }
            if ($null -ne $stderr) { $pending += $stderr }
            if ($pending.Count -gt 0) {
                [void][System.Threading.Tasks.Task]::WaitAny([System.Threading.Tasks.Task[]]$pending, 250)
            } else {
                Start-Sleep -Milliseconds 250
            }
        }
        $script:Child.WaitForExit()
        $exitCode = $script:Child.ExitCode
        # A daemon that ran for a while before exiting is a fresh failure, not part of a crash loop.
        if (([DateTime]::UtcNow - $startedAt).TotalSeconds -ge 60) { $retrySeconds = 1 }
        Write-RunnerLog "Daemon exited with code $exitCode. Restarting in $retrySeconds second(s)."
        $script:Child.Dispose()
        $script:Child = $null
        Start-Sleep -Seconds $retrySeconds
        $retrySeconds = [Math]::Min(30, $retrySeconds * 2)
    }
} catch {
    try { Write-RunnerLog "Runner error: $($_.Exception.Message)" } catch { }
    exit 1
} finally {
    Stop-ChildTree
    if ($null -ne $script:Child) {
        try { $script:Child.Dispose() } catch { }
    }
    try { Write-RunnerLog 'Runner stopped.' } catch { }
}
