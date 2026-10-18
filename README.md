# Charliflix

A desktop TV player with its own playback controls, feed choices and window-filling theater mode. The player resolves media locally instead of loading third-party advertising pages or player scripts. Commercials encoded in a broadcast remain.

## Download

Get a package from [GitHub Releases](https://github.com/charlesmbeckwith/charliflix/releases/latest).

- **Windows x64:** use **Charliflix-Setup.exe** for automatic updates. Node is included; the installer checks the .NET Framework 4.8 and Microsoft WebView2 requirements. The portable ZIP remains available for manual installations.
- **Apple Silicon Mac:** requires an M1 or newer Mac and macOS 13 or newer. Unzip and move `Charliflix.app` to Applications. The app includes its own runtime. This personal test build is ad-hoc signed and unnotarized; actual Mac launch and playback still need verification, and macOS may block it.

Neither app installs a background service or adds a login startup entry. The Windows installer creates the normal application shortcuts.

## Watching

Choose a channel, then use **Feed** to select Player 1 or Player 2. The app remembers your manual choice separately for each channel. It tries another available feed when a connection fails or video stalls, with a finite retry limit. You can switch feeds yourself if picture plays without sound.

**Theater** fills the app window. Press **T** to toggle it or **Escape** to leave. Fullscreen fills the monitor. Volume, mute and theater settings survive feed changes.

The lineup includes Cartoon Network, Comedy Central, FX, FXX, AMC and generic ABC, CBS, NBC, FOX and CW feeds. Network feeds are not guaranteed to be your local affiliates. PBS is currently disabled.

**Availability:** third-party feeds can lose sound, stall or disappear, and multiple player choices can fail together. Player 1 corresponds to the original site's Players 1, 3 and 7, which share a source; Player 2 uses an independent provider. Version 0.3.2 updates both adapters for provider changes observed on October 17, 2026. An update check can install an adapter repair, but availability still depends on the provider.

## Updates

**Windows installer:** the app checks automatically after startup and every four hours while open. It downloads an available update while you keep watching, then offers **Restart to update**. Installation happens only when you choose that action. Use **Check for updates** to check sooner. Settings and runtime data stay outside the versioned installation, under your local application data folder.

If you have version 0.2.0 or an older portable copy, install the new Setup once to get this update system. The old portable folder is left intact. Portable ZIPs and browser sessions continue to use manual download links; they never replace the developer checkout automatically.

**Mac:** the app checks automatically and notifies you about new releases. Download the Mac ZIP, close the app and replace the whole `Charliflix.app`; preferences are kept separately. Automatic installation is not enabled in this ad-hoc build. It needs a Developer ID signed distribution, which requires an [Apple Developer Program membership](https://developer.apple.com/programs/whats-included/).

Update checks use this public GitHub repository and send no account token or playback history. See [the changelog](CHANGELOG.md) for release changes.

## Run from source

Requires Node.js 22 or newer.

```sh
npm ci
npm test
npm start
```

Open `http://127.0.0.1:8767`. The server binds to loopback and accepts only local requests. On Windows, `Start-Channel-Room.cmd` and `Stop-Channel-Room.cmd` manage a verified local server; closing a browser tab alone leaves it running.

See [Windows packaging](desktop/README.md), [Mac packaging](mac/README.md) and [release instructions](RELEASING.md). Runtime binaries, profiles, build caches and diagnostic media are excluded from source control. Dependencies retain their own licenses in the release packages.
