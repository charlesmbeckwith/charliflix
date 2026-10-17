param([string]$PortableArchive, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$appRoot = [System.IO.Path]::GetFullPath((Split-Path $PSScriptRoot))
$package = Get-Content -LiteralPath (Join-Path $appRoot 'package.json') -Raw | ConvertFrom-Json
if ($package.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Installer version must be a stable semantic version.' }
if (-not $PortableArchive) {
    & (Join-Path $PSScriptRoot 'Package-Windows.ps1')
    $PortableArchive = Join-Path $appRoot 'dist\Charliflix-Windows-x64.zip'
}
$PortableArchive = [System.IO.Path]::GetFullPath($PortableArchive)
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $appRoot 'dist\windows-updates' }
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'installer-tool-manifest.json') -Raw | ConvertFrom-Json
$updaterSdk = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'updater-runtime-manifest.json') -Raw | ConvertFrom-Json
if ($updaterSdk.velopack.version -cne $manifest.version) { throw 'The application SDK and packaging CLI must use the same Velopack version.' }
$cacheRoot = Join-Path $PSScriptRoot '.cache'
[System.IO.Directory]::CreateDirectory($cacheRoot) | Out-Null
$toolArchive = Join-Path $cacheRoot $manifest.archive
if (-not (Test-Path -LiteralPath $toolArchive)) { Invoke-WebRequest -Uri $manifest.url -OutFile $toolArchive }
if ((Get-FileHash -LiteralPath $toolArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.sha256) { throw 'Official Velopack CLI checksum mismatch.' }
$dotnet = (Get-Command dotnet -ErrorAction Stop).Source
$workRoot = Join-Path $PSScriptRoot ('.build\installer-' + [Guid]::NewGuid().ToString('N'))
[System.IO.Directory]::CreateDirectory($workRoot) | Out-Null
try {
    # Isolated tool extraction prevents modified cached executables being trusted.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $toolRoot = Join-Path $workRoot 'tool'
    [System.IO.Compression.ZipFile]::ExtractToDirectory($toolArchive, $toolRoot)
    $tool = Join-Path $toolRoot $manifest.entryPoint
    $staging = Join-Path $workRoot 'payload'
    Expand-Archive -LiteralPath $PortableArchive -DestinationPath $staging
    $payload = Join-Path $staging 'Charliflix'
    $payloadPackage = Get-Content -LiteralPath (Join-Path $payload 'package.json') -Raw | ConvertFrom-Json
    if ($payloadPackage.version -cne $package.version -or $payloadPackage.name -cne $package.name) { throw 'Portable payload does not match the current app version.' }
    $portableEvidence = Get-Content -LiteralPath ([System.IO.Path]::ChangeExtension($PortableArchive, '.verification.json')) -Raw | ConvertFrom-Json
    if ($portableEvidence.archiveSha256 -ne (Get-FileHash -LiteralPath $PortableArchive -Algorithm SHA256).Hash.ToLowerInvariant()) { throw 'Portable archive does not match its verification manifest.' }
    if (@(Get-ChildItem -LiteralPath $payload -File -Recurse).Count -ne $portableEvidence.runtimeFiles) { throw 'Unexpected files in the portable payload.' }
    foreach ($property in $portableEvidence.payloadHashes.PSObject.Properties) {
        $source = Join-Path $payload $property.Name
        if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $property.Value) { throw "Portable payload hash mismatch: $($property.Name)" }
    }
    # The installer owns launchers/shortcuts. Retain the optional portable ZIP as
    # built, but give the installed app a distinct, explicitly audited payload.
    $omittedPortableFiles = @('Start Charliflix.cmd', 'desktop/Install-Desktop.ps1')
    foreach ($relative in $omittedPortableFiles) { Remove-Item -LiteralPath (Join-Path $payload $relative) }
    $installedReadme = @"
Charliflix $($package.version) - Windows installed edition

Open Charliflix from the Start menu. To pin it to the taskbar, right-click
the running Charliflix icon and choose Pin to taskbar.

The installer includes Node.js and checks for .NET Framework 4.8 and the
Microsoft Edge WebView2 Runtime. Missing prerequisites may require approval
through the normal Windows installer prompts. Internet access is required.

Charliflix checks the official GitHub releases for updates after startup
and periodically while open. Updates download in the background. When an
update is ready, use Restart to update in the app; it closes playback,
applies the verified downloaded package and reopens Charliflix.

Settings and the browser profile are stored separately from application
files in your local application data folder and survive app updates.
To remove the application, use Windows Settings > Apps > Charliflix.

Channel availability depends on third-party providers and may change.
Charliflix does not host or redistribute broadcasts.

This executable is not code-signed. Only download Charliflix from
https://github.com/charlesmbeckwith/charliflix/releases
"@
    [System.IO.File]::WriteAllText((Join-Path $payload 'Read Me.txt'), $installedReadme, [System.Text.UTF8Encoding]::new($false))
    $installerPayloadHashes = [ordered]@{}
    foreach ($property in $portableEvidence.payloadHashes.PSObject.Properties) {
        if ($property.Name -notin $omittedPortableFiles) {
            $installerPayloadHashes[$property.Name] = if ($property.Name -eq 'Read Me.txt') { (Get-FileHash -LiteralPath (Join-Path $payload 'Read Me.txt') -Algorithm SHA256).Hash.ToLowerInvariant() } else { $property.Value }
        }
    }
    $installerFiles = @(Get-ChildItem -LiteralPath $payload -File -Recurse)
    if ($installerFiles.Count -ne $installerPayloadHashes.Count) { throw 'Unexpected files in the installed payload.' }
    foreach ($file in $installerFiles) {
        $relative = $file.FullName.Substring($payload.Length + 1).Replace('\', '/')
        if (-not $installerPayloadHashes.Contains($relative) -or (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $installerPayloadHashes[$relative]) { throw "Unapproved installed payload file: $relative" }
    }
    $releases = Join-Path $workRoot 'releases'
    $packArguments = @($tool, '--skip-updates', '--legacyConsole', 'pack', '--packId', 'Charliflix', '--packTitle', 'Charliflix', '--packVersion', $package.version,
        '--packAuthors', 'charlesmbeckwith', '--packDir', $payload, '--mainExe', 'desktop/app/Charliflix.exe',
        '--runtime', 'win-x64', '--channel', 'win', '--framework', 'net48,webview2', '--aumid', 'ChannelRoom.Desktop',
        '--shortcuts', 'StartMenuRoot', '--instLocation', 'PerUser', '--delta', 'None', '--noPortable',
        '--icon', (Join-Path $PSScriptRoot 'assets\channel-room.ico'), '--outputDir', $releases)
    & $dotnet @packArguments
    if ($LASTEXITCODE -ne 0) { throw "Velopack packaging failed with exit code $LASTEXITCODE." }
    $fullPackages = @(Get-ChildItem -LiteralPath $releases -Filter '*-full.nupkg' -File)
    $setups = @(Get-ChildItem -LiteralPath $releases -Filter '*-Setup.exe' -File)
    if ($fullPackages.Count -ne 1 -or $setups.Count -ne 1) { throw 'Expected one full update package and one installer.' }
    $fullPackage = $fullPackages[0]
    $releaseIndex = Get-Content -LiteralPath (Join-Path $releases 'releases.win.json') -Raw | ConvertFrom-Json
    $fullAsset = @($releaseIndex.Assets | Where-Object { $_.Type -eq 'Full' -and $_.FileName -ceq $fullPackage.Name })
    if ($fullAsset.Count -ne 1 -or $fullAsset[0].Version -cne $package.version -or $fullAsset[0].PackageId -cne 'Charliflix') { throw 'Update index does not describe this release.' }
    if ($fullAsset[0].SHA256 -ne (Get-FileHash -LiteralPath $fullPackage.FullName -Algorithm SHA256).Hash) { throw 'Full package SHA256 differs from the update index.' }
    if ([long]$fullAsset[0].Size -ne $fullPackage.Length) { throw 'Full package length differs from the update index.' }
    $legacyIndex = (Get-Content -LiteralPath (Join-Path $releases 'RELEASES') -Raw).Trim() -split '\s+'
    if ($legacyIndex.Count -ne 3 -or $legacyIndex[1] -cne $fullPackage.Name -or [long]$legacyIndex[2] -ne $fullPackage.Length -or $legacyIndex[0] -ne (Get-FileHash -LiteralPath $fullPackage.FullName -Algorithm SHA1).Hash) { throw 'Legacy release index differs from the full update package.' }
    $archive = [System.IO.Compression.ZipFile]::OpenRead($fullPackage.FullName)
    try {
        $spec = @($archive.Entries | Where-Object { $_.FullName -eq 'Charliflix.nuspec' })
        if ($spec.Count -ne 1) { throw 'Missing Charliflix installer manifest.' }
        $reader = [System.IO.StreamReader]::new($spec[0].Open())
        try { [xml]$nuspec = $reader.ReadToEnd() } finally { $reader.Dispose() }
        $metadata = $nuspec.package.metadata
        if ($metadata.id -cne 'Charliflix' -or $metadata.version -cne $package.version -or $metadata.mainExe -cne 'desktop/app/Charliflix.exe') { throw 'Installer application identity, version or nested executable is wrong.' }
        if ($metadata.runtimeDependencies -notmatch 'net48' -or $metadata.runtimeDependencies -notmatch 'webview2' -or $metadata.shortcutAumid -cne 'ChannelRoom.Desktop') { throw 'Missing installer runtime prerequisites or shortcut identity.' }
        $packagedFiles = @{}
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if ($packagedFiles.ContainsKey($name)) { throw "Duplicate update package entry: $name" }
            $packagedFiles[$name] = $entry
        }
        foreach ($relative in $installerPayloadHashes.Keys) {
            $name = 'lib/app/' + $relative
            if (-not $packagedFiles.ContainsKey($name)) { throw "Installer omitted a runtime file: $relative" }
            $incoming = $packagedFiles[$name].Open()
            $sha = [System.Security.Cryptography.SHA256]::Create()
            try { $actual = [BitConverter]::ToString($sha.ComputeHash($incoming)).Replace('-', '').ToLowerInvariant() }
            finally { $incoming.Dispose(); $sha.Dispose() }
            if ($actual -ne $installerPayloadHashes[$relative]) { throw "Installer modified a runtime file: $relative" }
        }
        $allowedPayload = @('lib/app/Squirrel.exe', 'lib/app/sq.version', 'lib/app/Charliflix_ExecutionStub.exe')
        foreach ($name in $allowedPayload) {
            if (-not $packagedFiles.ContainsKey($name)) { throw "The full update package is missing a required helper: $name" }
        }
        $allowedPayload += @($installerPayloadHashes.Keys | ForEach-Object { 'lib/app/' + $_ })
        foreach ($name in $packagedFiles.Keys) {
            if ($name.StartsWith('lib/app/') -and -not $name.EndsWith('/') -and $name -notin $allowedPayload) { throw "Unapproved installer payload file: $name" }
        }
    } finally { $archive.Dispose() }
    $assetManifestPath = Join-Path $releases 'assets.win.json'
    $assetManifest = @(Get-Content -LiteralPath $assetManifestPath -Raw | ConvertFrom-Json)
    foreach ($asset in $assetManifest) {
        if ($asset.RelativeFileName -ceq $setups[0].Name -and $asset.Type -eq 'Installer') { $asset.RelativeFileName = 'Charliflix-Setup.exe' }
    }
    [System.IO.File]::WriteAllText($assetManifestPath, (ConvertTo-Json -InputObject $assetManifest -Compress), [System.Text.UTF8Encoding]::new($false))
    [System.IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
    $outputFiles = [ordered]@{}
    foreach ($file in Get-ChildItem -LiteralPath $releases -File) {
        # Preserve generated update metadata names; GitHubSource resolves them.
        $targetName = if ($file.Name -eq $setups[0].Name) { 'Charliflix-Setup.exe' } else { $file.Name }
        Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $OutputDirectory $targetName) -Force
        $outputFiles[$targetName] = (Get-FileHash -LiteralPath (Join-Path $OutputDirectory $targetName) -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    foreach ($asset in $assetManifest) {
        if (-not $outputFiles.Contains($asset.RelativeFileName)) { throw "Generated asset manifest references an unpublished file: $($asset.RelativeFileName)" }
    }
    $evidence = [ordered]@{ version = $package.version; appId = 'Charliflix'; mainExe = 'desktop/app/Charliflix.exe'; architecture = 'x64'; installerToolVersion = $manifest.version; installerToolSha256 = $manifest.sha256; prerequisites = @('net48', 'webview2'); aumid = 'ChannelRoom.Desktop'; installLocation = 'PerUser'; portablePayloadVerified = $true; omittedPortableFiles = $omittedPortableFiles; fullPackagePayloadHashesVerified = $installerPayloadHashes.Count; installerPayloadHashes = $installerPayloadHashes; releaseIndexVerified = $true; installedOrLaunched = $false; files = $outputFiles }
    $evidence | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'Charliflix-Installer.verification.json') -Encoding UTF8
    $sumLines = foreach ($name in $outputFiles.Keys) { $outputFiles[$name] + '  ' + $name }
    [System.IO.File]::WriteAllLines((Join-Path $OutputDirectory 'SHA256SUMS'), [string[]]$sumLines)
    Write-Output "Installer and update assets: $OutputDirectory"
    $outputFiles | ConvertTo-Json
} finally {
    $resolvedWork = [System.IO.Path]::GetFullPath($workRoot)
    $allowedWork = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '.build')) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolvedWork.StartsWith($allowedWork, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to clean an installer directory outside desktop/.build.' }
    if (Test-Path -LiteralPath $resolvedWork) { Remove-Item -LiteralPath $resolvedWork -Recurse -Force }
}
