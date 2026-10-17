param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$desktopRoot = $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path (Split-Path $desktopRoot) 'package.json') -Raw | ConvertFrom-Json
if ($package.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Desktop version must be a stable semantic version.' }
$sdkVersion = '1.0.4258.31'
$sdkSha256 = '56F7F4B8BF9AEE4B8EFEFBBDD4F67D5F74EBD1B100ED0806DA71BF76AF481AA9'
$sdkFolder = Join-Path $desktopRoot ".sdk\$sdkVersion"
$sdkArchive = Join-Path $desktopRoot '.sdk\microsoft.web.webview2.zip'
$appFolder = if ($OutputDirectory) { [System.IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $desktopRoot 'app' }
$compilerPath = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compilerPath)) { throw '.NET Framework 4.8 C# compiler was not found.' }
if (-not (Test-Path -LiteralPath $sdkArchive)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $sdkArchive) | Out-Null
    Invoke-WebRequest -Uri "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$sdkVersion/microsoft.web.webview2.$sdkVersion.nupkg" -OutFile $sdkArchive
}
if ((Get-FileHash -LiteralPath $sdkArchive -Algorithm SHA256).Hash -ne $sdkSha256) { throw 'The Microsoft WebView2 SDK archive failed its SHA256 check.' }
if (-not (Test-Path -LiteralPath (Join-Path $sdkFolder 'lib\net462\Microsoft.Web.WebView2.Core.dll'))) {
    Expand-Archive -LiteralPath $sdkArchive -DestinationPath $sdkFolder -Force
}
$updaterManifest = Get-Content -LiteralPath (Join-Path $desktopRoot 'updater-runtime-manifest.json') -Raw | ConvertFrom-Json
$updaterRoot = Join-Path $desktopRoot '.sdk\updater'
[System.IO.Directory]::CreateDirectory($updaterRoot) | Out-Null
foreach ($dependency in @(@{ Name = 'velopack'; Package = $updaterManifest.velopack }, @{ Name = 'newtonsoft.json'; Package = $updaterManifest.newtonsoft })) {
    $pinned = $dependency.Package
    $archive = Join-Path $updaterRoot ($dependency.Name + '.' + $pinned.version + '.zip')
    $folder = Join-Path $updaterRoot ($dependency.Name + '.' + $pinned.version)
    if (-not (Test-Path -LiteralPath $archive)) { Invoke-WebRequest -Uri $pinned.url -OutFile $archive }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pinned.sha256) { throw "The $($dependency.Name) updater SDK failed its SHA256 check." }
    # Re-extract from the verified package instead of trusting a stale SDK directory.
    Expand-Archive -LiteralPath $archive -DestinationPath $folder -Force
}
& (Join-Path $desktopRoot 'Make-Icon.ps1')
New-Item -ItemType Directory -Force -Path $appFolder | Out-Null
$versionSource = Join-Path $appFolder 'AssemblyVersion.cs'
('[assembly: System.Reflection.AssemblyVersion("' + $package.version + '.0")]' + [Environment]::NewLine + '[assembly: System.Reflection.AssemblyFileVersion("' + $package.version + '.0")]') | Set-Content -LiteralPath $versionSource -Encoding UTF8
$sdkLib = Join-Path $sdkFolder 'lib\net462'
foreach ($library in @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll')) {
    Copy-Item -LiteralPath (Join-Path $sdkLib $library) -Destination (Join-Path $appFolder $library) -Force
}
Copy-Item -LiteralPath (Join-Path $sdkFolder 'runtimes\win-x64\native\WebView2Loader.dll') -Destination (Join-Path $appFolder 'WebView2Loader.dll') -Force
Copy-Item -LiteralPath (Join-Path $sdkFolder 'LICENSE.txt') -Destination (Join-Path $appFolder 'WebView2-LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $sdkFolder 'NOTICE.txt') -Destination (Join-Path $appFolder 'WebView2-NOTICE.txt') -Force
$velopackFolder = Join-Path $updaterRoot ('velopack.' + $updaterManifest.velopack.version)
$newtonsoftFolder = Join-Path $updaterRoot ('newtonsoft.json.' + $updaterManifest.newtonsoft.version)
Copy-Item -LiteralPath (Join-Path $velopackFolder $updaterManifest.velopack.assembly) -Destination (Join-Path $appFolder 'Velopack.dll') -Force
Copy-Item -LiteralPath (Join-Path $newtonsoftFolder $updaterManifest.newtonsoft.assembly) -Destination (Join-Path $appFolder 'Newtonsoft.Json.dll') -Force
Copy-Item -LiteralPath (Join-Path $desktopRoot 'Velopack-LICENSE.txt') -Destination (Join-Path $appFolder 'Velopack-LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $newtonsoftFolder 'LICENSE.md') -Destination (Join-Path $appFolder 'Newtonsoft.Json-LICENSE.txt') -Force
$exePath = Join-Path $appFolder 'Charliflix.exe'
$compilerArgs = @('/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/langversion:5', "/out:$exePath",
    "/win32icon:$(Join-Path $desktopRoot 'assets\channel-room.ico')", "/win32manifest:$(Join-Path $desktopRoot 'app.manifest')",
    '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', '/reference:System.Net.Http.dll', '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll', "/reference:$(Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\WPF\WindowsBase.dll')",
    "/reference:$(Join-Path $appFolder 'Microsoft.Web.WebView2.Core.dll')", "/reference:$(Join-Path $appFolder 'Microsoft.Web.WebView2.WinForms.dll')",
    "/reference:$(Join-Path $appFolder 'Velopack.dll')", "/reference:$(Join-Path $appFolder 'Newtonsoft.Json.dll')",
    (Join-Path $desktopRoot 'ChannelRoom.cs'), (Join-Path $desktopRoot 'DesktopStartup.cs'), (Join-Path $desktopRoot 'DesktopUpdater.cs'), (Join-Path $desktopRoot 'VelopackUpdater.cs'), (Join-Path $desktopRoot 'Shortcut.cs'), $versionSource)
& $compilerPath @compilerArgs
if ($LASTEXITCODE -ne 0) { throw "Desktop compilation failed with exit code $LASTEXITCODE." }
@'
<?xml version="1.0" encoding="utf-8"?>
<configuration><startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8" /></startup><runtime><AppContextSwitchOverrides value="Switch.System.Windows.Forms.DoNotSupportSelectAllShortcutInMultilineTextBox=false;Switch.System.Windows.Forms.DoNotSupportDpiChanges=false" /></runtime></configuration>
'@ | Set-Content -LiteralPath "$exePath.config" -Encoding UTF8
Write-Output "Built $exePath"
