# Charliflix for Windows

Download **Charliflix-Setup.exe** from [Releases](https://github.com/charlesmbeckwith/charliflix/releases/latest). Run it once, then open Charliflix from the Start menu. The installer creates the application shortcut; friends do not need PowerShell, a command file, Git or a separate Node.js installation. Right-click the running app's taskbar icon to pin it.

Windows 10/11 x64, .NET Framework 4.8 and Microsoft WebView2 Evergreen are required. Node.js is included. Setup checks the .NET and WebView2 prerequisites and installs the app for the current user. It does not install a background service or add a login startup entry.

## Updates

Starting with version 0.3.0, installer-managed copies check GitHub after startup and every four hours while open. An available update downloads in the background while you keep watching. Choose **Restart to update** when convenient; closing the app normally does not install a downloaded update. **Check for updates** starts a check sooner.

Settings, the WebView2 profile, logs and server state are stored under `%LOCALAPPDATA%\Charliflix\user-data`, outside the application files replaced by updates. The profile is in its `desktop-profile` subfolder.

If you have version 0.2.0 or an older extracted copy, close it and run the new Setup once to get automatic updates. The old portable folder is left intact. Its preferences remain in that folder; they are not automatically imported into the new installed profile. Use the new Start menu shortcut afterward.

The app closes its owned loopback backend before applying an update. If it reused a separately started browser player, it asks you to close that player and stop its server, then reopen Charliflix before installing. It does not stop another launcher's server to force an update.

## Optional portable copy

The Windows x64 ZIP remains available for manual installations. Extract the complete folder somewhere you can write to, then open `desktop/app/Charliflix.exe`. Keep its files together. **Check for updates** opens the official release download; the portable copy does not replace itself.

To update a portable copy, close the app and stop any separately started browser server before replacing its extracted files. Keep `.runtime/desktop-profile` to preserve its preferences. Save the previous folder separately if you want a restore path. Developer checkouts also use the manual update path.

Windows executables are currently unsigned and may show an unknown-publisher warning. Download only from the official release page. Packages include the runtime dependencies' license notices. Installation and update behavior has not been verified on every supported Windows configuration.

## Build from source

Run `desktop/Build-Desktop.ps1` to compile the native host with pinned, checksum-verified WebView2, Velopack and Newtonsoft.Json SDK packages. It reads the application version from root `package.json`. `-OutputDirectory` builds elsewhere without replacing a running executable.

Run `desktop/Package-Windows.ps1` for the optional portable ZIP. It fetches the pinned official Node archive, verifies SHA256, includes only an explicit runtime allowlist, compiles into an isolated build folder, and verifies every packaged file hash.

Run `desktop/Package-Installer.ps1` to create Setup and the Velopack update assets. It requires the `dotnet` command for the pinned CLI. The installer keeps the public repository and application identity fixed; GitHub Releases hosts the installer, full update package and `releases.win.json`. Generated files are under `dist/`, which is excluded from Git. See [release instructions](../RELEASING.md) for publishing a version.
