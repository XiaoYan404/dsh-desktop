# Own the isolated GUI development session while keeping the original data and release records.
param(
    [switch]$Stop,
    [switch]$NoOpen,
    [ValidateRange(1, 65535)][int]$Port = 3081,
    [ValidateRange(10, 900)][int]$StartupTimeoutSeconds = 300,
    [string]$RuntimeRoot = '',
    [string]$NodeDirectory = '',
    [string]$ArtifactBackupManifest = ''
)

$ErrorActionPreference = 'Stop'
$hotProject = Split-Path -Parent $PSScriptRoot
$hotWorkspace = Split-Path -Parent $hotProject
$hotRuntimeRoot = if ($RuntimeRoot) { [System.IO.Path]::GetFullPath($RuntimeRoot) } else { Join-Path $hotWorkspace '.local-run' }
$hotControllerRoot = Join-Path $hotRuntimeRoot 'gui-hot-dev'
$hotNodeDirectory = if ($NodeDirectory) { [System.IO.Path]::GetFullPath($NodeDirectory) } else { Join-Path $hotRuntimeRoot 'node-v24.22.0-win-x64' }
$hotNode = Join-Path $hotNodeDirectory 'node.exe'
$hotStatePath = Join-Path $hotControllerRoot 'state.json'
$hotBrowserData = Join-Path $hotControllerRoot 'browser'
$hotData = Join-Path $hotControllerRoot 'data'
$hotBaseUrl = "http://127.0.0.1:$Port/"

function Write-HotUtf8File([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

# Keep the process object and its opened handle together until cleanup finishes.
function Read-HotProcessIdentity([int]$ProcessId, [string]$ExpectedPath, [string]$StartedUtc, $ObservedBirth) {
    $hotIdentityProcess = $null
    $hotRetainHandle = $false
    try {
        try { $hotIdentityProcess = Get-Process -Id $ProcessId -ErrorAction Stop }
        catch {
            if ($_.CategoryInfo.Category -eq [System.Management.Automation.ErrorCategory]::ObjectNotFound) {
                return [pscustomobject]@{Kind='gone';Process=$null}
            }
            return [pscustomobject]@{Kind='unavailable';Process=$null}
        }
        if (-not $hotIdentityProcess -or $hotIdentityProcess.HasExited) { return [pscustomobject]@{Kind='gone';Process=$null} }
        $hotActualStarted = $hotIdentityProcess.StartTime.ToUniversalTime()
        if (-not $ExpectedPath -or (-not $StartedUtc -and -not $ObservedBirth)) { return [pscustomobject]@{Kind='unavailable';Process=$null} }
        $hotActualPath = [string]$hotIdentityProcess.Path
        if ([string]::IsNullOrWhiteSpace($hotActualPath)) { return [pscustomobject]@{Kind='unavailable';Process=$null} }
        if ($hotActualPath -ne $ExpectedPath) { return [pscustomobject]@{Kind='different';Process=$null} }
        if ($StartedUtc -and $hotActualStarted.ToString('o') -ne $StartedUtc) { return [pscustomobject]@{Kind='different';Process=$null} }
        if ($ObservedBirth) {
            $hotObservedUtc = ([DateTime]$ObservedBirth).ToUniversalTime()
            # Win32_Process publishes microseconds; Process.StartTime retains 100ns ticks.
            if (($hotActualStarted.Ticks - ($hotActualStarted.Ticks % 10)) -ne ($hotObservedUtc.Ticks - ($hotObservedUtc.Ticks % 10))) {
                return [pscustomobject]@{Kind='different';Process=$null}
            }
        }
        [void]$hotIdentityProcess.Handle
        if ($hotIdentityProcess.HasExited) { return [pscustomobject]@{Kind='gone';Process=$null} }
        $hotRetainHandle = $true
        return [pscustomobject]@{Kind='owned';Process=$hotIdentityProcess}
    } catch {
        return [pscustomobject]@{Kind='unavailable';Process=$null}
    } finally {
        if (-not $hotRetainHandle -and $hotIdentityProcess -and $hotIdentityProcess.PSObject.Methods['Dispose']) { $hotIdentityProcess.Dispose() }
    }
}

function Close-HotProcessSnapshot($Snapshot) {
    foreach ($hotCapturedProcess in $Snapshot.Targets) {
        if ($hotCapturedProcess.PSObject.Methods['Dispose']) { $hotCapturedProcess.Dispose() }
    }
}

# Recover only saved identities, then extend them through a current, birth-checked tree.
function Get-HotProcessSnapshot($State, [switch]$IncludeGui) {
    $hotTargets = @{}
    $hotProblems = [System.Collections.Generic.List[string]]::new()
    $hotUnverifiedRecords = [System.Collections.Generic.List[object]]::new()
    $hotRootIdentity = Read-HotProcessIdentity ([int]$State.ProcessId) $hotNode $State.ProcessStartedUtc $null
    if ($hotRootIdentity.Kind -eq 'different') { throw 'The recorded development process no longer matches its original identity.' }
    $hotRootAlive = $hotRootIdentity.Kind -eq 'owned'
    if ($hotRootAlive) { $hotTargets[[int]$State.ProcessId] = $hotRootIdentity.Process }
    elseif ($hotRootIdentity.Kind -eq 'unavailable') { $hotProblems.Add('The supervisor identity cannot be inspected.') }
    $hotRecordedRoot = @($State.TrackedProcesses | Where-Object {
        $_.ProcessId -eq $State.ProcessId -and $_.ExecutablePath -eq $hotNode -and $_.StartedUtc -eq $State.ProcessStartedUtc
    })
    $hotRecordedSession = $State.TrackedRootStartedUtc -eq $State.ProcessStartedUtc -and $hotRecordedRoot.Count -eq 1
    if (-not $hotRootAlive -and -not $hotRecordedSession) {
        $hotProblems.Add('The supervisor is gone and child ownership was not recorded. Retained logs must be reviewed before stopping unverified processes.')
    }
    if ($hotRecordedSession) {
        foreach ($hotRecord in $State.TrackedProcesses) {
            if ($hotTargets.ContainsKey([int]$hotRecord.ProcessId)) { continue }
            $hotRecordedIdentity = Read-HotProcessIdentity ([int]$hotRecord.ProcessId) $hotRecord.ExecutablePath $hotRecord.StartedUtc $null
            if ($hotRecordedIdentity.Kind -eq 'owned') { $hotTargets[[int]$hotRecord.ProcessId] = $hotRecordedIdentity.Process }
            elseif ($hotRecordedIdentity.Kind -eq 'unavailable') {
                $hotProblems.Add("Recorded process $($hotRecord.ProcessId) cannot be inspected.")
                $hotUnverifiedRecords.Add($hotRecord)
            }
        }
    }
    if ($IncludeGui) {
        foreach ($hotGuiRoot in @(Get-HotGuiProcesses)) {
            if ($hotTargets.ContainsKey([int]$hotGuiRoot.ProcessId)) { continue }
            $hotGuiIdentity = Read-HotProcessIdentity ([int]$hotGuiRoot.ProcessId) $hotGuiRoot.ExecutablePath $null $hotGuiRoot.CreationDate
            if ($hotGuiIdentity.Kind -eq 'owned') { $hotTargets[[int]$hotGuiRoot.ProcessId] = $hotGuiIdentity.Process }
            elseif ($hotGuiIdentity.Kind -eq 'unavailable') { $hotProblems.Add('The owned GUI process cannot be inspected.') }
        }
    }
    try {
        $hotTree = @(Get-CimInstance Win32_Process)
        $hotVisited = [System.Collections.Generic.HashSet[int]]::new()
        do {
            $hotTreeAdded = $false
            foreach ($hotTreeEntry in $hotTree) {
                $hotChildId = [int]$hotTreeEntry.ProcessId
                $hotParentId = [int]$hotTreeEntry.ParentProcessId
                if (-not $hotTargets.ContainsKey($hotParentId) -or $hotTargets.ContainsKey($hotChildId) -or -not $hotVisited.Add($hotChildId)) { continue }
                if (-not $hotTreeEntry.CreationDate -or -not $hotTreeEntry.ExecutablePath) {
                    $hotProblems.Add("Child process $hotChildId lacks verifiable creation metadata.")
                    continue
                }
                if (([DateTime]$hotTreeEntry.CreationDate).ToUniversalTime() -lt $hotTargets[$hotParentId].StartTime.ToUniversalTime()) { continue }
                $hotChildIdentity = Read-HotProcessIdentity $hotChildId $hotTreeEntry.ExecutablePath $null $hotTreeEntry.CreationDate
                if ($hotChildIdentity.Kind -eq 'owned') { $hotTargets[$hotChildId] = $hotChildIdentity.Process; $hotTreeAdded = $true }
                elseif ($hotChildIdentity.Kind -eq 'unavailable') { $hotProblems.Add("Child process $hotChildId cannot be inspected.") }
            }
        } while ($hotTreeAdded)
    } catch {
        $hotProblems.Add('The current development process tree cannot be inspected.')
    }
    return [pscustomobject]@{Targets=@($hotTargets.Values);Problems=@($hotProblems);UnverifiedRecords=@($hotUnverifiedRecords);RootAlive=$hotRootAlive;RecordedSession=$hotRecordedSession}
}

function Set-HotProcessLedger($State, $Snapshot) {
    $hotLeases = @($Snapshot.Targets | ForEach-Object {
        [pscustomobject]@{ProcessId=$_.Id;ExecutablePath=$_.Path;StartedUtc=$_.StartTime.ToUniversalTime().ToString('o')}
    })
    foreach ($hotUnverifiedRecord in $Snapshot.UnverifiedRecords) {
        $hotLeases += [pscustomobject]@{ProcessId=$hotUnverifiedRecord.ProcessId;ExecutablePath=$hotUnverifiedRecord.ExecutablePath;StartedUtc=$hotUnverifiedRecord.StartedUtc}
    }
    # Retain the supervisor's generation after it exits, so a later stop can recover children.
    if (-not @($hotLeases | Where-Object {$_.ProcessId -eq $State.ProcessId}).Count) {
        $hotLeases += [pscustomobject]@{ProcessId=$State.ProcessId;ExecutablePath=$hotNode;StartedUtc=$State.ProcessStartedUtc}
    }
    $State | Add-Member -MemberType NoteProperty -Name TrackedProcesses -Value $hotLeases -Force
    $State | Add-Member -MemberType NoteProperty -Name TrackedRootStartedUtc -Value $State.ProcessStartedUtc -Force
}

function Save-HotProcessLedger($State) {
    $hotSnapshot = Get-HotProcessSnapshot $State
    try {
        if (-not $hotSnapshot.RootAlive -or $hotSnapshot.Problems.Count) { throw 'The live development process tree could not be recorded. Data and logs were retained.' }
        Set-HotProcessLedger $State $hotSnapshot
        Write-HotUtf8File $hotStatePath (($State | ConvertTo-Json -Depth 6) + "`n")
    } finally { Close-HotProcessSnapshot $hotSnapshot }
}

function Get-HotGuiProcesses {
    $hotProfilePattern = '(?:^|\s)--user-data-dir=(?:"' + [regex]::Escape($hotBrowserData) + '"|' + [regex]::Escape($hotBrowserData) + ')(?:\s|$)'
    @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -in @('chrome.exe', 'msedge.exe') -and [string]$_.CommandLine -match $hotProfilePattern -and
        [string]$_.CommandLine -notmatch '(?:^|\s)--type='
    })
}

function Show-HotGuiWindow([System.Diagnostics.Process]$Process) {
    $Process.Refresh()
    if ($Process.MainWindowHandle -eq [IntPtr]::Zero) { return $false }
    if (-not ('DshHotGui.NativeWindow' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace DshHotGui {
  public static class NativeWindow {
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  }
}
'@
    }
    if ([DshHotGui.NativeWindow]::IsIconic($Process.MainWindowHandle)) {
        [void][DshHotGui.NativeWindow]::ShowWindowAsync($Process.MainWindowHandle, 9)
    }
    [void][DshHotGui.NativeWindow]::SetForegroundWindow($Process.MainWindowHandle)
    return $true
}

function Get-HotSavedEntry($State) {
    if (-not (Test-Path -LiteralPath $State.Stdout)) { throw 'The development startup log is missing. Stop this instance before starting it again.' }
    $hotSavedLog = (Get-Content -LiteralPath $State.Stdout -Raw -Encoding UTF8) -replace '\x1b\[[0-9;]*m', ''
    $hotSavedLinks = [regex]::Matches($hotSavedLog, "http://127\.0\.0\.1:$($State.Port)/[^\s`"<>]+")
    $hotSavedEntry = $null
    foreach ($hotLink in $hotSavedLinks) { if ($hotLink.Value -match '\?token=') { $hotSavedEntry = $hotLink.Value } }
    if (-not $hotSavedEntry) { throw 'The development authentication entry is missing. Stop this instance before starting it again.' }
    return $hotSavedEntry
}

function Open-HotGui($State, [string]$Entry) {
    $hotOwnedBrowsers = @(Get-HotGuiProcesses)
    foreach ($hotOwnedBrowser in $hotOwnedBrowsers) {
        $hotOwnedProcess = Get-Process -Id $hotOwnedBrowser.ProcessId -ErrorAction SilentlyContinue
        if ($hotOwnedProcess -and (Show-HotGuiWindow $hotOwnedProcess)) {
            $State.BrowserProcessId = $hotOwnedProcess.Id
            Write-HotUtf8File $hotStatePath (($State | ConvertTo-Json -Depth 4) + "`n")
            return
        }
    }
    if (-not $Entry) { $Entry = Get-HotSavedEntry $State }
    $hotBrowser = $hotOwnedBrowsers | Select-Object -ExpandProperty ExecutablePath -First 1
    if (-not $hotBrowser) {
        $hotBrowser = @('C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe') |
            Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    }
    if (-not $hotBrowser) { throw 'A Chromium browser is required for the independent GUI window.' }
    $hotBrowserArguments = @((('--app="' + $Entry + '"')), ('--user-data-dir="' + $hotBrowserData + '"'), '--window-size=1440,1000', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9225', '--no-first-run', '--no-default-browser-check')
    $hotGui = Start-Process -FilePath $hotBrowser -ArgumentList $hotBrowserArguments -PassThru
    $State.BrowserProcessId = $hotGui.Id
    Write-HotUtf8File $hotStatePath (($State | ConvertTo-Json -Depth 4) + "`n")
}

function Use-HotDevelopment {
    if (-not (Test-Path -LiteralPath $hotStatePath)) { return $false }
    $hotPrevious = Get-Content -LiteralPath $hotStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $hotPreviousProcess = Get-Process -Id $hotPrevious.ProcessId -ErrorAction SilentlyContinue
    if (-not $hotPreviousProcess) { return $false }
    if ($hotPreviousProcess.Path -ne $hotNode -or $hotPreviousProcess.StartTime.ToUniversalTime().ToString('o') -ne $hotPrevious.ProcessStartedUtc) { return $false }
    if ($hotPrevious.Status -ne 'running') { throw 'The previous development startup did not reach running. Review its logs and use the Stop shortcut before trying again.' }
    if ([int]$hotPrevious.Port -ne $Port) { throw "GUI hot development already uses port $($hotPrevious.Port). Stop it before selecting a different port." }
    Save-HotProcessLedger $hotPrevious
    if (-not $NoOpen) { Open-HotGui $hotPrevious $null }
    Write-Host "GUI hot development is already running at http://127.0.0.1:$($hotPrevious.Port)/"
    return $true
}

function Stop-HotDevelopment {
    if (-not (Test-Path -LiteralPath $hotStatePath)) { Write-Host 'GUI hot development is not running.'; return }
    $hotState = Get-Content -LiteralPath $hotStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $hotSnapshot = Get-HotProcessSnapshot $hotState -IncludeGui
    $hotStopProblems = [System.Collections.Generic.List[string]]::new()
    foreach ($hotProblem in $hotSnapshot.Problems) { $hotStopProblems.Add($hotProblem) }
    $hotStopTargets = @($hotSnapshot.Targets)
    try {
        if ($hotSnapshot.RootAlive -or $hotSnapshot.RecordedSession) {
            Set-HotProcessLedger $hotState $hotSnapshot
            Write-HotUtf8File $hotStatePath (($hotState | ConvertTo-Json -Depth 6) + "`n")
        }
        foreach ($hotTarget in $hotStopTargets) {
            try {
                if (-not $hotTarget.HasExited) { Stop-Process -InputObject $hotTarget -ErrorAction Stop }
                if (-not $hotTarget.WaitForExit(3000)) { $hotStopProblems.Add("Recorded process $($hotTarget.Id) is still running.") }
            } catch {
                $hotExitConfirmed = $false
                try { $hotExitConfirmed = $hotTarget.HasExited }
                catch {
                    # Keep the stop failure when Windows cannot confirm the process exit.
                    $hotExitReadError = $_
                    $hotExitConfirmed = $false
                }
                if (-not $hotExitConfirmed) { $hotStopProblems.Add("Recorded process $($hotTarget.Id) could not be stopped.") }
            }
        }
        if ($hotStopProblems.Count) {
            $hotState.Status = 'stop-failed'
            Write-HotUtf8File $hotStatePath (($hotState | ConvertTo-Json -Depth 6) + "`n")
            throw ('Some development processes could not be verified or stopped. Data and logs were retained. ' + ($hotStopProblems -join ' '))
        }
        $hotState.Status = 'stopped'
        Write-HotUtf8File $hotStatePath (($hotState | ConvertTo-Json -Depth 6) + "`n")
    } finally {
        Close-HotProcessSnapshot $hotSnapshot
    }
    Write-Host 'GUI window, development server and owned watchers stopped. Data was retained.'
}

if ($Stop) { Stop-HotDevelopment; return }
if (-not (Test-Path -LiteralPath $hotNode)) { throw 'Node 24.22.0 is missing.' }
New-Item -ItemType Directory -Path $hotControllerRoot -Force | Out-Null
$hotStartupLock = $null
try {
    $hotStartupLock = [System.IO.File]::Open((Join-Path $hotControllerRoot 'startup.lock'), [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
} catch [System.IO.IOException] {
    if (($_.Exception.HResult -band 0xffff) -notin @(32, 33)) { throw }
    Write-Host 'GUI hot development is already starting. Wait for the application window or review its startup log.'
    return
}
try {
if (Use-HotDevelopment) { return }
$hotBackup = if ($ArtifactBackupManifest) { [System.IO.Path]::GetFullPath($ArtifactBackupManifest) } else { Join-Path $hotProject '.artifacts/gui-hot-dev-20261024/artifact-backup.json' }
if (-not (Test-Path -LiteralPath $hotBackup)) { throw 'The artifact backup must complete before starting watchers.' }
$hotBackupState = Get-Content -LiteralPath $hotBackup -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $hotBackupState.complete) { throw 'The artifact backup is incomplete.' }
$hotClientScript = Get-Content -LiteralPath (Join-Path $hotProject 'scripts/dev-web.ts') -Raw -Encoding UTF8
if ($hotClientScript -notmatch "env:\s*\{[^{}]*DSH_BUILD_FACE:\s*'client'[^{}]*\}") { throw 'The Client-only watch configuration is required.' }
$hotListener = @(netstat -ano -p tcp | Select-String -Pattern "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+")
if ($hotListener.Count -gt 0) { throw "Port $Port is occupied. Stop its verified project owner before starting development." }
if (-not $NoOpen) {
    $hotDebugListener = @(netstat -ano -p tcp | Select-String -Pattern '^\s*TCP\s+\S+:9225\s+\S+\s+LISTENING\s+')
    if ($hotDebugListener.Count -gt 0) { throw 'GUI development port 9225 is occupied.' }
}

New-Item -ItemType Directory -Path $hotData -Force | Out-Null
$env:PATH = $hotNodeDirectory + ';' + (Join-Path $hotProject 'node_modules/.bin') + ';' + $env:PATH
$env:DSH_OFFICE_DEV_HOME = $hotData
$env:NO_COLOR = '1'
$env:pnpm_config_verify_deps_before_run = 'warn'
$hotLogStamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
$hotStdout = Join-Path $hotControllerRoot "development-$hotLogStamp.log"
$hotStderr = Join-Path $hotControllerRoot "development-$hotLogStamp.err.log"
$hotPnpm = Join-Path $hotProject 'node_modules/pnpm/bin/pnpm.cjs'
$hotArguments = @(('"' + $hotPnpm + '"'), '--config.verifyDepsBeforeRun=warn', 'run', 'dev:office', '--built-host', '--skip-build', '--no-open', '--port', [string]$Port)
$hotProcess = Start-Process -FilePath $hotNode -ArgumentList $hotArguments -WorkingDirectory $hotProject -WindowStyle Hidden -RedirectStandardOutput $hotStdout -RedirectStandardError $hotStderr -PassThru
$hotState = [PSCustomObject]@{
    Status='starting'; ProcessId=$hotProcess.Id; ProcessStartedUtc=$hotProcess.StartTime.ToUniversalTime().ToString('o'); Port=$Port;
    DataDirectory=$hotData; Stdout=$hotStdout; Stderr=$hotStderr; GuiMode='Chromium application window'; BrowserProcessId=0; DebugPort=9225; HostEntry='apps/cli/lib/bin.js'
}
Write-HotUtf8File $hotStatePath (($hotState | ConvertTo-Json -Depth 4) + "`n")
$hotEntry = $null
$hotDeadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
while ([DateTime]::UtcNow -lt $hotDeadline) {
    $hotProcess.Refresh()
    if ($hotProcess.HasExited) { throw "Development exited with code $($hotProcess.ExitCode). See $hotStderr" }
    if (Test-Path -LiteralPath $hotStdout) {
        $hotLog = (Get-Content -LiteralPath $hotStdout -Raw -Encoding UTF8) -replace '\x1b\[[0-9;]*m',''
        $hotLinks = [regex]::Matches($hotLog, "http://127\.0\.0\.1:$Port/[^\s`"<>]+")
        foreach ($hotLink in $hotLinks) { if ($hotLink.Value -match '\?token=') { $hotEntry = $hotLink.Value } }
        if ($hotEntry) { break }
    }
    Start-Sleep -Milliseconds 500
}
if (-not $hotEntry) { throw "Development is not ready after $StartupTimeoutSeconds seconds. See $hotStdout and $hotStderr" }
Save-HotProcessLedger $hotState
$hotShortcut = Join-Path $hotControllerRoot 'GUI-hot-development.url'
Write-HotUtf8File $hotShortcut ("[InternetShortcut]`r`nURL=" + $hotEntry + "`r`n")
if (-not $NoOpen) {
    Open-HotGui $hotState $hotEntry
}
$hotState.Status = 'running'
Write-HotUtf8File $hotStatePath (($hotState | ConvertTo-Json -Depth 4) + "`n")
$hotPreviousControls = Join-Path $hotControllerRoot 'previous-controls'
New-Item -ItemType Directory -Path $hotPreviousControls -Force | Out-Null
foreach ($hotControlName in @('enterprise-preview-process.json','enterprise-workbench.url')) {
    $hotControl = Join-Path $hotRuntimeRoot $hotControlName
    $hotControlBefore = Join-Path $hotPreviousControls $hotControlName
    if ((Test-Path -LiteralPath $hotControl) -and -not (Test-Path -LiteralPath $hotControlBefore)) { Copy-Item -LiteralPath $hotControl -Destination $hotControlBefore }
}
$hotServer = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { [string]$_.CommandLine -match 'apps[/\\]cli[/\\](src[/\\]bin\.ts|lib[/\\]bin\.js).*\bweb\b' -and [string]$_.CommandLine -match "--port\s+$Port\b" } | Select-Object -First 1
$hotPreview = [PSCustomObject]@{
    ProcessId=$(if ($hotServer) { $hotServer.ProcessId } else { $hotProcess.Id }); SupervisorProcessId=$hotProcess.Id; Port=$Port;
    Runtime='Node 24.22.0, Client source watchers and built CLI entry'; StartedUtc=$hotState.ProcessStartedUtc;
    PrivateLog=('gui-hot-dev/' + [System.IO.Path]::GetFileName($hotStdout)); Mode='office-hot-development'; DataDirectory=$hotData
}
Write-HotUtf8File (Join-Path $hotRuntimeRoot 'enterprise-preview-process.json') (($hotPreview | ConvertTo-Json -Depth 4) + "`n")
Copy-Item -LiteralPath $hotShortcut -Destination (Join-Path $hotRuntimeRoot 'enterprise-workbench.url')
$hotDevelopmentMarker = [PSCustomObject]@{ Mode='development'; ProcessId=$hotProcess.Id; StartedUtc=$hotState.ProcessStartedUtc; CompleteReleaseBuild=$false; PriorBuildRecordPreservedInArtifactBackup=$true }
New-Item -ItemType Directory -Path (Join-Path $hotProject '.dsh-build') -Force | Out-Null
Write-HotUtf8File (Join-Path $hotProject '.dsh-build/development-session.json') (($hotDevelopmentMarker | ConvertTo-Json) + "`n")
Write-Host "GUI hot development is running at $hotBaseUrl"
Write-Host 'Client TypeScript, TSX and CSS watchers are active. Host changes require a restart.'
Write-Host 'Development data is isolated; existing project data was retained.'
} catch {
    if ($hotState -and $hotProcess -and (Test-Path -LiteralPath $hotStatePath)) {
        $hotSavedState = Get-Content -LiteralPath $hotStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($hotSavedState.ProcessId -eq $hotProcess.Id -and $hotSavedState.Status -ne 'stopped') {
            $hotSavedState.Status = 'failed'
            Write-HotUtf8File $hotStatePath (($hotSavedState | ConvertTo-Json -Depth 4) + "`n")
        }
    }
    throw
} finally {
    if ($hotStartupLock) { $hotStartupLock.Dispose() }
}
