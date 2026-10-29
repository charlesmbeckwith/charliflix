# Charliflix

A desktop TV player with its own playback controls, feed choices and window-filling theater mode. The player resolves media locally instead of loading third-party advertising pages or player scripts. Commercials encoded in a broadcast remain.

## Download

Get a package from [GitHub Releases](https://github.com/charlesmbeckwith/charliflix/releases/latest).

- **Windows x64:** use **Charliflix-Setup.exe** for automatic updates. Node is included; the installer checks the .NET Framework 4.8 and Microsoft WebView2 requirements. The portable ZIP remains available for manual installations.
- **Apple Silicon Mac:** requires an M1 or newer Mac and macOS 13 or newer. Unzip and move `Charliflix.app` to Applications. The app includes its own runtime. This personal test build is ad-hoc signed and unnotarized; actual Mac launch and playback still need verification, and macOS may block it.

Neither app installs a background service or adds a login startup entry. The Windows installer creates the normal application shortcuts.

## Watching

Choose a channel, then use **Feed** to select a source. Every channel has Player 1 and Player 2; **ABC, CBS, NBC and FOX also have CDNLiveTV** as a third option. The app remembers your manual choice separately for each channel. It tries another available feed when a connection fails or video stalls, with a finite retry limit. A fallback says which player failed and which is being tried; if all fail, the error lists their actual attempt order. Automatic fallback preserves your saved manual choice. You can switch feeds yourself if picture plays without sound.

Manual attempts have up to 35 seconds to start. Automatic fallback attempts have 15 seconds each, so adding sources does not add another 35-second wait for every failed option. Once playback starts, the normal playback-progress and pause handling apply. Only the selected source is loaded.

**Theater** fills the app window. Press **T** to toggle it or **Escape** to leave. **M** toggles mute. Fullscreen fills the monitor. Volume, mute and theater settings survive feed changes.

The player fits the available window space while keeping the video's proportions. The lineup scrolls independently, so browsing channels keeps the video and controls in place. In narrow windows the lineup moves below the player and keeps its own scroll area.

The lineup includes Cartoon Network, Comedy Central, FX, FXX, AMC and generic ABC, CBS, NBC, FOX and CW feeds. Network feeds are not guaranteed to be your local affiliates. PBS is currently disabled.

### Guide and scheduled switches

Press **G** or choose **Guide** to open the program guide. Click a show airing now to tune immediately. Click an upcoming show to save an automatic channel change; click it again or use **Cancel switch** to remove it. If two shows start at the same time, the guide asks which switch to keep. **Escape** closes the guide before leaving theater mode.

Scheduled switches are saved on this device. **Keep Charliflix open**, including minimized, for a switch to run. The app does not start itself, wake a sleeping computer or install a background scheduler. On wake or reopening, a start missed by up to five minutes can run while that show is still airing; older or ended shows are skipped. Scheduling requires app storage and Web Locks support, included in current WebView2 and the Mac app.

Listings come from [EPGTalk's public JSON guide](https://epgtalk.com/api.html), with a rolling window of roughly ten hours ahead. Times display in your local time zone. Current titles appear beneath the channel names and refresh automatically. The five cable channels use **Eastern reference schedules**, which may differ from the actual feed. ABC, CBS, NBC, FOX and CW are marked **Guide not matched** because these feeds do not identify their affiliates. No local-affiliate schedule is guessed.

The app refreshes listings every 30 minutes and keeps a covered last-good guide in memory when the source is temporarily unavailable. Schedules already saved on this device continue to work without a guide connection. Guide requests are anonymous and send no watch queue or playback history to EPGTalk.

**Availability:** third-party feeds can lose sound, stall or disappear, and multiple player choices can fail together. The original site has seven player buttons. Players 1, 3 and 7 share a source; Player 2 uses an independent provider. The remaining slots use different embedded providers depending on the channel. An October 28, 2026 check covered those three slots across all ten channels; errors, interactive verification or stale content prevented additional working sources from those slots. See the [channel-by-channel findings](docs/feed-availability.md).

CDNLiveTV uses the exact `ABC US`, `CBS US`, `NBC US` and `FOX US` entries in [its documented public free catalog](https://cdnlivetv.tv/). The app reads the public player's literal data without loading its page or scripts into the interface. Those network affiliates remain unidentified, so their guide listings stay unmatched. No corresponding cable or CW entries were found in that catalog.

Version 0.3.6 follows the original site's move from dlive.sx to thedaddy.pk, saves verified alternate addresses, and recognizes the primary provider's newly observed edge. An update check can install an adapter repair, but availability still depends on the provider.

## Updates

**Windows installer:** the app checks automatically after startup and every four hours while open. It downloads an available update while you keep watching, then offers **Restart to update**. Installation happens only when you choose that action. Use **Check for updates** to check sooner. Settings and runtime data stay outside the versioned installation, under your local application data folder.

**One-time repair for Windows 0.3.0–0.3.2:** install **0.3.3 or newer** from a fresh download of Charliflix-Setup.exe. Those versions had an update connection bug and cannot download this repair through the app. Close Charliflix before running the fresh installer; reopening an older Setup saved in Downloads installs that older version.

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
