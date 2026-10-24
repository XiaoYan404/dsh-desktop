param([switch]$CheckOnly, [switch]$Watch)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$prototypeRoot = $PSScriptRoot
$appPath = Join-Path $prototypeRoot 'app.py'
if ($Watch) { $appPath = Join-Path $prototypeRoot 'preview_live.py' }
$candidates = [System.Collections.Generic.List[string]]::new()
function Add-Candidate([string]$Path) {
    if ($Path -and (Test-Path -LiteralPath $Path -PathType Leaf) -and -not $candidates.Contains($Path)) {
        $candidates.Add($Path)
    }
}
try {
    Add-Candidate (Join-Path $prototypeRoot '.venv\Scripts\python.exe')
    foreach ($commandName in @('python.exe', 'python3.exe')) {
        foreach ($command in @(Get-Command $commandName -All -ErrorAction SilentlyContinue)) {
            if ($command.Source -notlike '*\WindowsApps\*') { Add-Candidate $command.Source }
        }
    }
    $py = Get-Command 'py.exe' -ErrorAction SilentlyContinue
    if ($py) {
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $resolved = & $py.Source -3 -c 'import sys; print(sys.executable)' 2>$null
            $resolveExit = $LASTEXITCODE
        } finally { $ErrorActionPreference = $previousPreference }
        if ($resolveExit -eq 0) { Add-Candidate ([string]($resolved | Select-Object -Last 1)) }
    }
    foreach ($base in @('HKCU:\Software\Python\PythonCore', 'HKLM:\Software\Python\PythonCore')) {
        if (Test-Path $base) {
            foreach ($key in Get-ChildItem $base) {
                $installKey = Join-Path $key.PSPath 'InstallPath'
                if (Test-Path $installKey) {
                    $installed = (Get-Item $installKey).GetValue('')
                    if ($installed) { Add-Candidate (Join-Path $installed 'python.exe') }
                }
            }
        }
    }
    $selectedPython = $null
    foreach ($candidate in $candidates) {
        # An unsuitable interpreter is a candidate miss, not a terminating PS error.
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $probe = & $candidate -c 'import sys; from PyQt5.QtWidgets import QApplication; from PyQt5.QtNetwork import QLocalServer; assert sys.version_info >= (3, 9); print(51511)' 2>$null
            $probeExit = $LASTEXITCODE
        } finally { $ErrorActionPreference = $previousPreference }
        if ($probeExit -eq 0 -and $probe -contains '51511') { $selectedPython = $candidate; break }
    }
    if (-not $selectedPython) {
        Write-Host 'No Python 3.9+ with PyQt5 was found.' -ForegroundColor Yellow
        Write-Host 'Install Python, then run: python -m pip install -r requirements.txt'
        Write-Host 'No packages or system settings were changed.'
        exit 1
    }
    if (-not (Test-Path -LiteralPath $appPath)) { throw 'app.py is missing. Keep the prototype files together.' }
    if ($CheckOnly) {
        Write-Output "PYQT_READY: $selectedPython"
        Write-Output "APP: $appPath"
        exit 0
    }
    $guiPython = Join-Path (Split-Path $selectedPython -Parent) 'pythonw.exe'
    if (-not (Test-Path -LiteralPath $guiPython)) { $guiPython = $selectedPython }
    # The native GUI must be visible; using Hidden here can hide its first window.
    Start-Process -FilePath $guiPython -WorkingDirectory $prototypeRoot -WindowStyle Normal -ArgumentList ('"' + $appPath + '"') | Out-Null
    Write-Output 'Prototype launched. Repeating this command activates the existing window.'
    if ($Watch) { Write-Output 'Live preview: saving application Python files restarts the preview.' }
    exit 0
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
