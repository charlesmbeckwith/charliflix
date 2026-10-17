param([string]$Output)
$ErrorActionPreference = 'Stop'
$appRoot = [System.IO.Path]::GetFullPath((Split-Path $PSScriptRoot))
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime-manifest.json') -Raw | ConvertFrom-Json
$package = Get-Content -LiteralPath (Join-Path $appRoot 'package.json') -Raw | ConvertFrom-Json
if ($package.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Release version must be a stable semantic version.' }
$cacheRoot = Join-Path $PSScriptRoot '.cache'
[System.IO.Directory]::CreateDirectory($cacheRoot) | Out-Null
$nodeArchive = Join-Path $cacheRoot $manifest.archive
if (-not (Test-Path -LiteralPath $nodeArchive)) { Invoke-WebRequest -Uri $manifest.url -OutFile $nodeArchive }
if ((Get-FileHash -LiteralPath $nodeArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.sha256) { throw 'Official Node.js runtime checksum mismatch.' }
if (-not $Output) { $Output = Join-Path $appRoot 'dist\Charliflix-Windows-x64.zip' }
$Output = [System.IO.Path]::GetFullPath($Output)
[System.IO.Directory]::CreateDirectory((Split-Path $Output)) | Out-Null
$buildRoot = Join-Path $PSScriptRoot ('.build\release-' + [Guid]::NewGuid().ToString('N'))
[System.IO.Directory]::CreateDirectory($buildRoot) | Out-Null
$payload = Join-Path $buildRoot 'Charliflix'
$compiled = Join-Path $buildRoot 'compiled'
$runtime = Join-Path $buildRoot 'node'
$expectedFiles = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
function Add-PayloadFile([string]$Source, [string]$Relative) {
    if ($Relative -match '(^|[\/])\.\.?([\/]|$)' -or [System.IO.Path]::IsPathRooted($Relative)) { throw 'Invalid release payload path.' }
    $destination = Join-Path $payload $Relative
    [System.IO.Directory]::CreateDirectory((Split-Path $destination)) | Out-Null
    Copy-Item -LiteralPath $Source -Destination $destination
    [void]$expectedFiles.Add($Relative.Replace('\', '/'))
}
try {
    & (Join-Path $PSScriptRoot 'Build-Desktop.ps1') -OutputDirectory $compiled
    Expand-Archive -LiteralPath $nodeArchive -DestinationPath $runtime
    $nodeRoot = Join-Path $runtime ('node-v' + $manifest.nodeVersion + '-win-x64')
    foreach ($name in @('node.exe', 'LICENSE')) { Add-PayloadFile (Join-Path $nodeRoot $name) ('desktop/runtime/' + $name) }
    foreach ($name in @('Charliflix.exe', 'Charliflix.exe.config', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll', 'WebView2-LICENSE.txt', 'WebView2-NOTICE.txt', 'Velopack.dll', 'Newtonsoft.Json.dll', 'Velopack-LICENSE.txt', 'Newtonsoft.Json-LICENSE.txt')) {
        Add-PayloadFile (Join-Path $compiled $name) ('desktop/app/' + $name)
    }
    foreach ($name in @('server.cjs', 'launch.cjs', 'package.json')) { Add-PayloadFile (Join-Path $appRoot $name) $name }
    if (Test-Path -LiteralPath (Join-Path $appRoot 'LICENSE')) { Add-PayloadFile (Join-Path $appRoot 'LICENSE') 'LICENSE' }
    Add-PayloadFile (Join-Path $appRoot 'config\channels.json') 'config/channels.json'
    foreach ($name in @('host.cjs', 'runtime.cjs', 'Install-Desktop.ps1')) { Add-PayloadFile (Join-Path $PSScriptRoot $name) ('desktop/' + $name) }
    Add-PayloadFile (Join-Path $PSScriptRoot 'assets\channel-room.ico') 'desktop/assets/channel-room.ico'
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $appRoot 'lib') -Filter '*.cjs' -File) { Add-PayloadFile $file.FullName ('lib/' + $file.Name) }
    foreach ($name in @('app.js', 'styles.css', 'index.html', 'favicon.svg')) { Add-PayloadFile (Join-Path $appRoot ('public/' + $name)) ('public/' + $name) }
    foreach ($name in @('LICENSE', 'package.json')) { Add-PayloadFile (Join-Path $appRoot ('node_modules/hls.js/' + $name)) ('node_modules/hls.js/' + $name) }
    Add-PayloadFile (Join-Path $appRoot 'node_modules/hls.js/dist/hls.min.js') 'node_modules/hls.js/dist/hls.min.js'
    foreach ($name in @('LICENSE', 'package.json')) { Add-PayloadFile (Join-Path $appRoot ('node_modules/pngjs/' + $name)) ('node_modules/pngjs/' + $name) }
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $appRoot 'node_modules/pngjs/lib') -Filter '*.js' -File) { Add-PayloadFile $file.FullName ('node_modules/pngjs/lib/' + $file.Name) }
    $readme = @"
Charliflix $($package.version) - Windows x64

Extract the entire Charliflix folder to a folder you can write to, then
open desktop/app/Charliflix.exe. Keep all files together.
Node.js is included. Windows 10/11 x64, .NET Framework 4.8 and Microsoft Edge
WebView2 Runtime are required. .NET and WebView2 are normally already installed.
If WebView2 is missing, install it from https://developer.microsoft.com/microsoft-edge/webview2/

For a taskbar shortcut, right-click the running Charliflix icon and choose
Pin to taskbar. An optional Start Menu shortcut can be created by running
desktop/Install-Desktop.ps1 -StartMenu in PowerShell.

This ZIP is the portable edition. For automatic Windows updates, install
Charliflix-Setup.exe from the official GitHub release instead. The installed
edition checks for updates, downloads them in the background and lets you
choose when to restart and apply them.

For this portable edition, use Check for updates to open the latest official
GitHub release, close the app and replace its extracted files manually.
Keep the .runtime folder when replacing files to preserve preferences.

Internet access is required. Channel availability depends on third-party
providers and may change. The app does not host or redistribute broadcasts.

This executable is not code-signed. Windows may show an unknown publisher.
Only download releases from https://github.com/charlesmbeckwith/charliflix
and compare the release SHA256SUMS when verifying a download.
"@
    [System.IO.File]::WriteAllText((Join-Path $payload 'Read Me.txt'), $readme, [System.Text.UTF8Encoding]::new($false))
    [void]$expectedFiles.Add('Read Me.txt')
    [System.IO.File]::WriteAllText((Join-Path $payload 'Start Charliflix.cmd'), "@echo off`r`nstart `"`" `"%~dp0desktop\app\Charliflix.exe`"`r`n", [System.Text.ASCIIEncoding]::new())
    [void]$expectedFiles.Add('Start Charliflix.cmd')
    $files = Get-ChildItem -LiteralPath $payload -File -Recurse
    if ($files.Count -ne $expectedFiles.Count) { throw 'Unexpected files in release staging.' }
    $hashes = [ordered]@{}
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($payload.Length + 1).Replace('\', '/')
        if (-not $expectedFiles.Contains($relative)) { throw "Unapproved release file: $relative" }
        $hashes[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $temporaryZip = Join-Path $buildRoot 'release.zip'
    Compress-Archive -LiteralPath $payload -DestinationPath $temporaryZip -CompressionLevel Optimal
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($temporaryZip)
    try {
        $archived = @($zip.Entries | Where-Object { -not $_.FullName.EndsWith('/') })
        if ($archived.Count -ne $expectedFiles.Count) { throw 'The packaged ZIP contains unexpected files.' }
        foreach ($entry in $archived) {
            $name = $entry.FullName.Replace('\', '/')
            if (-not $name.StartsWith('Charliflix/') -or -not $expectedFiles.Contains($name.Substring('Charliflix/'.Length))) { throw "Unapproved ZIP entry: $name" }
            $incoming = $entry.Open()
            $sha = [System.Security.Cryptography.SHA256]::Create()
            try { $actual = [BitConverter]::ToString($sha.ComputeHash($incoming)).Replace('-', '').ToLowerInvariant() }
            finally { $incoming.Dispose(); $sha.Dispose() }
            if ($actual -ne $hashes[$name.Substring('Charliflix/'.Length)]) { throw "Archive payload hash mismatch: $name" }
        }
    } finally { $zip.Dispose() }
    Copy-Item -LiteralPath $temporaryZip -Destination $Output -Force
    $archiveHash = (Get-FileHash -LiteralPath $Output -Algorithm SHA256).Hash.ToLowerInvariant()
    $evidence = [ordered]@{ version = $package.version; architecture = 'x64'; nodeVersion = $manifest.nodeVersion; nodeArchiveSha256 = $manifest.sha256; archive = [System.IO.Path]::GetFileName($Output); archiveSha256 = $archiveHash; runtimeFiles = $hashes.Count; allowlistVerified = $true; payloadHashes = $hashes }
    $evidence | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath ([System.IO.Path]::ChangeExtension($Output, '.verification.json')) -Encoding UTF8
    [System.IO.File]::WriteAllText(($Output + '.sha256'), ($archiveHash + '  ' + [System.IO.Path]::GetFileName($Output) + "`n"))
    Write-Output "Windows archive: $Output"
    Write-Output "SHA256: $archiveHash"
} finally {
    $resolvedBuild = [System.IO.Path]::GetFullPath($buildRoot)
    $allowedBuild = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '.build')) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolvedBuild.StartsWith($allowedBuild, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to clean a build directory outside desktop/.build.' }
    if (Test-Path -LiteralPath $resolvedBuild) { Remove-Item -LiteralPath $resolvedBuild -Recurse -Force }
}
