param([string]$Distribution = 'Ubuntu-24.04', [string]$Output)
$ErrorActionPreference = 'Stop'
$macRoot = $PSScriptRoot
$appRoot = Split-Path $macRoot
$cacheRoot = Join-Path $macRoot '.cache'
New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
$downloads = @(
    @{
        Name = 'electron-v44.7.2-darwin-arm64.zip'
        Url = 'https://github.com/electron/electron/releases/download/v44.7.2/electron-v44.7.2-darwin-arm64.zip'
        Hash = '07D73D3D6DD0B8679C2F1849E30DF179EA50C1D6B17630FCC398AE05221F0BD2'
    },
    @{
        Name = 'apple-codesign-0.29.0-x86_64-unknown-linux-musl.tar.gz'
        Url = 'https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F0.29.0/apple-codesign-0.29.0-x86_64-unknown-linux-musl.tar.gz'
        Hash = 'DBE85CEDD8EE4217B64E9A0E4C2AEF92AB8BCAAA41F20BDE99781FF02E600002'
    }
)
foreach ($download in $downloads) {
    $archivePath = Join-Path $cacheRoot $download.Name
    if (-not (Test-Path -LiteralPath $archivePath)) { Invoke-WebRequest -Uri $download.Url -OutFile $archivePath }
    if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $download.Hash) { throw "Checksum mismatch for $($download.Name)." }
}
& (Join-Path $macRoot 'Make-Icon.ps1')
$linuxRoot = (& wsl.exe --distribution $Distribution --exec wslpath -a $appRoot).Trim()
if ($LASTEXITCODE -ne 0 -or -not $linuxRoot.StartsWith('/')) { throw 'Could not resolve the app folder in the selected WSL environment.' }
if ($Output) {
    $absoluteOutput = [System.IO.Path]::GetFullPath($Output)
    $linuxOutput = (& wsl.exe --distribution $Distribution --exec wslpath -a $absoluteOutput).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $linuxOutput.StartsWith('/')) { throw 'Could not resolve the output archive in WSL.' }
    & wsl.exe --distribution $Distribution --exec python3 "$linuxRoot/mac/build_macos.py" --output $linuxOutput
} else {
    & wsl.exe --distribution $Distribution --exec python3 "$linuxRoot/mac/build_macos.py"
}
if ($LASTEXITCODE -ne 0) { throw "Mac packaging failed with exit code $LASTEXITCODE. See mac/.cache/signing.log." }
Write-Output "Mac archive: $(if ($Output) { $absoluteOutput } else { Join-Path $appRoot 'dist\Charliflix-Apple-Silicon.zip' })"
