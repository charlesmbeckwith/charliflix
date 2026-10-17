param([switch]$StartMenu)
$ErrorActionPreference = 'Stop'
$appRoot = Split-Path $PSScriptRoot
$exePath = Join-Path $PSScriptRoot 'app\Charliflix.exe'
if (-not (Test-Path -LiteralPath $exePath)) { throw 'Build the desktop app with Build-Desktop.ps1 first.' }
function New-ChannelRoomShortcut([string]$shortcutPath) {
    if (Test-Path -LiteralPath $shortcutPath) {
        $shellObject = New-Object -ComObject WScript.Shell
        try {
            $existingShortcut = $shellObject.CreateShortcut($shortcutPath)
            if ($existingShortcut.TargetPath -ne $exePath) { throw "An unrelated shortcut already exists at $shortcutPath. It was not changed." }
            Write-Output "Shortcut already exists: $shortcutPath"
        } finally {
            if ($null -ne $existingShortcut) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($existingShortcut) }
            [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shellObject)
        }
        return
    }
    $installProcess = Start-Process -FilePath $exePath -ArgumentList @('--shortcut', ('"' + $shortcutPath + '"')) -WindowStyle Hidden -Wait -PassThru
    if ($installProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $shortcutPath)) { throw "Could not create $shortcutPath. No existing shortcut was replaced." }
    Write-Output "Created $shortcutPath"
}
New-ChannelRoomShortcut (Join-Path $appRoot 'Charliflix.lnk')
if ($StartMenu) {
    $programsPath = [Environment]::GetFolderPath('Programs')
    if (-not (Test-Path -LiteralPath $programsPath)) { throw 'The current user Start Menu folder was not found.' }
    New-ChannelRoomShortcut (Join-Path $programsPath 'Charliflix.lnk')
}
Write-Output 'Open Charliflix, right-click its taskbar icon, and choose Pin to taskbar.'
