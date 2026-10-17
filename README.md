# Charliflix

A desktop TV player with its own playback controls, feed choices and window-filling theater mode. The player resolves media locally instead of loading third-party advertising pages or player scripts. Commercials encoded in a broadcast remain.

## Download

Get a package from [GitHub Releases](https://github.com/charlesmbeckwith/charliflix/releases/latest).

- **Windows x64:** unzip the complete folder and open `desktop/app/Charliflix.exe`. Node is included. Microsoft WebView2 Evergreen and .NET Framework 4.8 are required. Keep the folder in place; you can pin the running app to the taskbar.
- **Apple Silicon Mac:** requires an M1 or newer Mac and macOS 13 or newer. Unzip and move `Charliflix.app` to Applications. The app includes its own runtime. This personal test build is ad-hoc signed and unnotarized; actual Mac launch and playback still need verification, and macOS may block it.

The first Windows release is a portable ZIP, not an installer. Neither package installs a background service or adds an automatic startup entry.

## Watching

Choose a channel, then use **Feed** to select Player 1 or Player 2. The app remembers your manual choice separately for each channel. It tries another available feed when a connection fails or video stalls, with a finite retry limit. You can switch feeds yourself if picture plays without sound.

**Theater** fills the app window. Press **T** to toggle it or **Escape** to leave. Fullscreen fills the monitor. Volume, mute and theater settings survive feed changes.

The lineup includes Cartoon Network, Comedy Central, FX, FXX, AMC and generic ABC, CBS, NBC, FOX and CW feeds. Network feeds are not guaranteed to be your local affiliates. PBS is currently disabled.

**Availability:** third-party feeds can lose sound, stall or disappear, and multiple player choices can fail together. Player 1 corresponds to the original site's Players 1, 3 and 7, which share a source; Player 2 uses an independent provider. No working replacement was found for several channels during October 16, 2026 checks. An update check does not repair an upstream outage.

## Updates

Use **Check for updates** in the app. It checks this public repository's latest stable release and offers a link to the release page. Updates are downloaded and installed manually; the app does not silently replace itself.

- On Windows, close the app and extract the new package over the existing folder. Preserve `.runtime/desktop-profile` to keep preferences. Copy the old folder first if you want an easy restore path.
- On Mac, close the app and replace the whole `Charliflix.app`; preferences are kept separately.

Update checks send no account token or playback history. They run when requested, not on a background schedule. See [the changelog](CHANGELOG.md) for release changes.

## Run from source

Requires Node.js 22 or newer.

```sh
npm ci
npm test
npm start
```

Open `http://127.0.0.1:8767`. The server binds to loopback and accepts only local requests. On Windows, `Start-Channel-Room.cmd` and `Stop-Channel-Room.cmd` manage a verified local server; closing a browser tab alone leaves it running.

See [Windows packaging](desktop/README.md), [Mac packaging](mac/README.md) and [release instructions](RELEASING.md). Runtime binaries, profiles, build caches and diagnostic media are excluded from source control. Dependencies retain their own licenses in the release packages.
