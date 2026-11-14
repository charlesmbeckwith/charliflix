# Charliflix

A TV player for Windows, Apple Silicon Mac and Android, with its own playback controls, feed choices and window-filling theater mode. The player resolves media locally instead of loading third-party advertising pages or player scripts. Commercials encoded in a broadcast or archive recording remain.

## Download

Get a package from [GitHub Releases](https://github.com/charlesmbeckwith/charliflix/releases/latest).

- **Windows x64:** use **Charliflix-Setup.exe** for automatic updates. Node is included; the installer checks the .NET Framework 4.8 and Microsoft WebView2 requirements. The portable ZIP remains available for manual installations.
- **Apple Silicon Mac:** requires an M1 or newer Mac and macOS 13 or newer. Unzip and move `Charliflix.app` to Applications. The app includes its own runtime. This personal test build is ad-hoc signed and unnotarized; actual Mac launch and playback still need verification, and macOS may block it.
- **Android ARM64 — initial beta:** install **Charliflix-v0.3.11-Android-arm64.apk** on Android 8 or newer, including the Retroid Pocket Nova. The APK includes the player and local backend; no PC, server account or additional service is needed. It uses the device's Android System WebView. Actual Nova launch, playback and controller behavior still need device verification. See [Android installation and build notes](android/README.md).

The apps do not install a background service or add a login startup entry. The Windows installer creates the normal application shortcuts; the Android APK adds a normal launcher app.

## Watching

Choose a channel, then use **Feed** to select a source. Live cable and network channels have Player 1 and Player 2; **ABC, CBS, NBC and FOX also have CDNLiveTV** as a third option. Adult Swim Archive uses its single archive source. The app remembers your manual choice separately for each channel. It tries another available feed when a connection fails or video stalls, with a finite retry limit. A fallback says which player failed and which is being tried; if all fail, the error lists their actual attempt order. Automatic fallback preserves your saved manual choice. You can switch feeds yourself if picture plays without sound.

Live-feed manual attempts have up to 35 seconds to start. Automatic fallback attempts have 15 seconds each, so adding sources does not add another 35-second wait for every failed option. Archive recordings allow up to two minutes for the initial load and seek, then one minute without video progress before showing an error. If an archive recovers, its error clears automatically. Only the selected source is loaded.

**Theater** fills the app window. Press **T** to toggle it or **Escape** to leave. **M** toggles mute. Fullscreen fills the monitor. Volume, mute and theater settings survive feed changes.

The player fits the available window space while keeping the video's proportions. The lineup scrolls independently, so browsing channels keeps the video and controls in place. In narrow windows the lineup moves below the player and keeps its own scroll area.

The lineup includes Cartoon Network, Comedy Central, FX, FXX, AMC, Adult Swim Archive and generic ABC, CBS, NBC, FOX and CW feeds. Network feeds are not guaranteed to be your local affiliates. PBS is currently disabled.

**Adult Swim Archive** uses the public archive recordings listed by [Spelunkr's Late Nite Swimclub, channel 54](https://spelunkr.tv/). These are older Adult Swim blocks rather than the current cable broadcast. Charliflix runs its **own rotation**, so its timing differs from Spelunkr's player. It seeks to the current position, honors recording trims and changes to the next block automatically. The current title and upcoming rotation appear in the guide, with roughly 24 hours of archive listings and scheduled channel switches. The **LIVE** button returns to the current rotation position. Public availability and source credit do not establish redistribution rights or legal clearance.

On Android, touch controls and channel scrolling work alongside the Nova's controller: **D-pad** moves focus, **A** selects, **B** goes back, **X** mutes, **Y** opens the guide, **L1/R1** change channel and **Start** toggles theater mode. Back leaves fullscreen, the guide or theater before leaving the app. Android playback pauses when the app goes into the background; tap Play after returning.

### Guide and scheduled switches

Press **G** or choose **Guide** to open the program guide. Click a show airing now to tune immediately. Click an upcoming show to save an automatic channel change; click it again or use **Cancel switch** to remove it. If two shows start at the same time, the guide asks which switch to keep. **Escape** closes the guide before leaving theater mode.

Scheduled switches are saved on this device. **Keep Charliflix open** for a switch to run: desktop apps can be minimized, while **Android must remain in the foreground** because its playback and browser timers pause in the background. The app does not start itself, wake a sleeping device or install a background scheduler. On wake or reopening, a start missed by up to five minutes can run while that show is still airing; older or ended shows are skipped. Scheduling requires app storage and a current WebView or browser with Web Locks support.

Live-feed listings come from [EPGTalk's public JSON guide](https://epgtalk.com/api.html), with a rolling window of roughly ten hours ahead. Adult Swim Archive listings describe Charliflix's own rotation. Times display in your local time zone. Current titles appear beneath the channel names and refresh automatically. The five cable channels use **Eastern reference schedules**, which may differ from the actual feed. ABC, CBS, NBC, FOX and CW are marked **Guide not matched** because these feeds do not identify their affiliates. No local-affiliate schedule is guessed.

The app refreshes listings every 30 minutes and keeps a covered last-good guide in memory when the source is temporarily unavailable. Schedules already saved on this device continue to work without a guide connection. Guide requests are anonymous and send no watch queue or playback history to EPGTalk.

**Availability:** third-party feeds can lose sound, stall or disappear, and multiple player choices can fail together. The original site has seven player buttons. Players 1, 3 and 7 share a source; Player 2 uses an independent provider. The remaining slots use different embedded providers depending on the channel. An October 28, 2026 check covered those three slots across all ten channels; errors, interactive verification or stale content prevented additional working sources from those slots. See the [channel-by-channel findings](docs/feed-availability.md).

CDNLiveTV uses the exact `ABC US`, `CBS US`, `NBC US` and `FOX US` entries in [its documented public free catalog](https://cdnlivetv.tv/). The app reads the public player's literal data without loading its page or scripts into the interface. Those network affiliates remain unidentified, so their guide listings stay unmatched. No corresponding cable or CW entries were found in that catalog.

Version 0.3.6 follows the original site's move from dlive.sx to thedaddy.pk, saves verified alternate addresses, and recognizes the primary provider's newly observed edge. An update check can install an adapter repair, but availability still depends on the provider.

## Updates

**Windows installer:** the app checks automatically after startup and every four hours while open. It downloads an available update while you keep watching, then offers **Restart to update**. Installation happens only when you choose that action. Use **Check for updates** to check sooner. Settings and runtime data stay outside the versioned installation, under your local application data folder.

**One-time repair for Windows 0.3.0–0.3.2:** install **0.3.3 or newer** from a fresh download of Charliflix-Setup.exe. Those versions had an update connection bug and cannot download this repair through the app. Close Charliflix before running the fresh installer; reopening an older Setup saved in Downloads installs that older version.

If you have version 0.2.0 or an older portable copy, install the new Setup once to get this update system. The old portable folder is left intact. Portable ZIPs and browser sessions continue to use manual download links; they never replace the developer checkout automatically.

**Mac:** the app checks automatically and notifies you about new releases. Download the Mac ZIP, close the app and replace the whole `Charliflix.app`; preferences are kept separately. Automatic installation is not enabled in this ad-hoc build. It needs a Developer ID signed distribution, which requires an [Apple Developer Program membership](https://developer.apple.com/programs/whats-included/).

**Android:** choose **Check for updates**, open the release and download its **Android-arm64.apk**. Install it over the existing Charliflix app to preserve settings and scheduled switches; do not uninstall first. Android asks you to approve installation. Release APKs use the retained Charliflix signing key, so later releases can update the same app. Installation is manual in this beta; GitHub Releases hosts the APK without a paid update service.

Update checks use this public GitHub repository and send no account token or playback history. See [the changelog](CHANGELOG.md) for release changes.

## Run from source

Requires Node.js 22 or newer.

```sh
npm ci
npm test
npm start
```

Open `http://127.0.0.1:8767`. The server binds to loopback and accepts only local requests. On Windows, `Start-Channel-Room.cmd` and `Stop-Channel-Room.cmd` manage a verified local server; closing a browser tab alone leaves it running.

See [Windows packaging](desktop/README.md), [Mac packaging](mac/README.md), [Android packaging](android/README.md) and [release instructions](RELEASING.md). Runtime binaries, profiles, signing keys, build caches and diagnostic media are excluded from source control. Dependencies retain their own licenses in the release packages.
