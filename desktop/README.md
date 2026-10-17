# Charliflix for Windows

Download the Windows x64 ZIP from [Releases](https://github.com/charlesmbeckwith/charliflix/releases/latest). Extract the complete folder somewhere you can write to, then open `Start Charliflix.cmd` or `desktop/app/Charliflix.exe`.

The release includes Node.js. Windows 10/11 x64, .NET Framework 4.8 and Microsoft WebView2 Evergreen are required. Keep the folder in place. Right-click the running app in the taskbar to pin it. Optional `desktop/Install-Desktop.ps1 -StartMenu` creates a Start Menu shortcut.

The app owns its loopback server when it starts one. Closing the app stops that server. A server reused from a browser session remains under its original launcher. Close all app instances and stop any separately started browser server before replacing files for an update.

Use **Check for updates** to check the public GitHub release. Updates are manual: close the app and extract the new ZIP over the existing folder. Preserve `.runtime/desktop-profile` to retain preferences. A copy of the old folder provides a restore path. No service or startup entry is installed.

The executable is currently unsigned. The portable ZIP has not been tested on every supported Windows configuration. Microsoft dependencies retain their notices, and the bundled Node runtime includes its license.

## Build from source

Run `desktop/Build-Desktop.ps1` to compile the native host with the pinned WebView2 SDK. It reads the application version from root `package.json`. `-OutputDirectory` builds elsewhere without replacing a running executable.

Run `desktop/Package-Windows.ps1` for the friends ZIP. It fetches the pinned official Node archive, verifies SHA256, includes only an explicit runtime allowlist, compiles into an isolated build folder, and verifies every packaged file hash. Generated archives are under `dist/`, which is excluded from Git.
