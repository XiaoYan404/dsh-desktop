param(
    [string]$Installer = '',
    [string]$InstallDirectory = '',
    [string]$Report = '',
    [string]$UpgradeFromReceipt = '',
    [string]$InputAsar = ''
)

$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
if (-not $Installer) { $Installer = Join-Path $repository 'dist-enterprise\EnterpriseOfficeAgent-Dev-20261025-r2-x64-Setup.exe' }
if (-not $InstallDirectory) { $InstallDirectory = Join-Path $env:LOCALAPPDATA 'Programs\Enterprise Office Agent Dev' }
if (-not $Report) { $Report = Join-Path $repository '.build\enterprise-checks\installer-install-r1.json' }
$Installer = [IO.Path]::GetFullPath($Installer)
$InstallDirectory = [IO.Path]::GetFullPath($InstallDirectory)
$Report = [IO.Path]::GetFullPath($Report)
if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) { throw 'The completed installer is required.' }
if (Test-Path -LiteralPath $InstallDirectory) {
    if (-not $UpgradeFromReceipt) { throw 'The install destination already exists; preserve it and inspect its owner.' }
    $prior = Get-Content -LiteralPath $UpgradeFromReceipt -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $prior.Passed -or $prior.InstallDirectory -ne $InstallDirectory) { throw 'The previous install receipt does not own this directory.' }
}
if (Test-Path -LiteralPath $Report) { throw 'The existing check receipt must not be overwritten or rerun.' }

$result = [ordered]@{
    StartedUtc = [DateTime]::UtcNow.ToString('o')
    Passed = $false
    InstallDirectory = $InstallDirectory
    InstallerSha256 = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant()
    InstallerBytes = (Get-Item -LiteralPath $Installer).Length
    SignatureStatus = [string](Get-AuthenticodeSignature -LiteralPath $Installer).Status
    SourceGuiThreeAttemptCapPreserved = $true
    CompleteReleaseBuild = $false
}
try {
    # NSIS requires /D to be last and unquoted, including a directory with spaces.
    $process = Start-Process -FilePath $Installer -ArgumentList @('/S', ('/D=' + $InstallDirectory)) -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit(900000)) { throw 'The owned installation has not completed within its recorded timeout.' }
    $result.ExitCode = $process.ExitCode
    if ($process.ExitCode -ne 0) { throw 'The installer exited unsuccessfully.' }
    $program = Join-Path $InstallDirectory 'Enterprise Office Agent Dev.exe'
    $resources = Join-Path $InstallDirectory 'resources\enterprise-development'
    $node = Join-Path $resources '.local-run\node-v24.22.0-win-x64\node.exe'
    if (-not (Test-Path -LiteralPath $program -PathType Leaf)) { throw 'The installed GUI executable is missing.' }
    $nodeVersion = & $node --version
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -ne 'v24.22.0') { throw 'The installed Node version does not match.' }
    $manager = Get-Content -LiteralPath (Join-Path $resources '.local-run\node-v24.22.0-win-x64\node_modules\pnpm\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manager.version -ne '11.28.5') { throw 'The installed pnpm version does not match.' }
    $inputAsar = if ($InputAsar) { [IO.Path]::GetFullPath($InputAsar) } else { Join-Path $repository 'dist-enterprise\win-unpacked\resources\app.asar' }
    $installedAsar = Join-Path $InstallDirectory 'resources\app.asar'
    if ((Get-FileHash -LiteralPath $inputAsar -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $installedAsar -Algorithm SHA256).Hash) { throw 'The installed app differs from its packaged input.' }
    $result.Node = $nodeVersion
    $result.Pnpm = $manager.version
    $result.InstalledAsarMatches = $true
    $result.Passed = $true
} catch {
    $result.Error = $_.Exception.Message
    throw
} finally {
    $result.FinishedUtc = [DateTime]::UtcNow.ToString('o')
    [IO.File]::WriteAllText($Report, (($result | ConvertTo-Json -Depth 6) + "`n"), [Text.UTF8Encoding]::new($false))
    Write-Output ('Installer check passed: ' + $result.Passed)
}
