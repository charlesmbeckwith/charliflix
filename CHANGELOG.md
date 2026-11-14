# Changelog

## 0.3.12

- Added Android picture-in-picture: playing video can remain visible when pressing Home or switching apps, with a native play/pause action and an optional setting. Fully hidden or dismissed playback still pauses.
- Fixed channel cards expanding over the player or neighboring portrait column. Long channel, show and episode text scrolls inside bounded rows, preserving the normal video surface size.
- Added episode names and season/episode numbers beneath show titles, plus guide details on long press, right-click, I or Shift+F10. Descriptions appear when provided by the guide.
- Added persistent local watched-episode history and badges, manual mark/unmark controls and automatic marks after roughly 80% unique playback coverage. Pauses, seeks and unplayed background time do not count; unidentified archive blocks are not inferred as episodes.
- Added Settings with teal, blue, purple, pink, orange and white accents, the Android PiP preference and confirmed history clearing. History and settings survive normal app updates.
- Added Android emulator PiP lifecycle, storage-recreation and portrait/landscape long-text layout checks, alongside playback/history regressions.

## 0.3.11

- Fixed a slow archive load immediately showing a playback error after video had started. First playback now starts a fresh progress deadline.
- Clear a recoverable archive timeout when video resumes, including recovery without another `playing` event, and restore automatic block transitions.
- Allow archive recordings up to two minutes for initial loading and seeking, and one minute for later buffering or resume. Live-feed fallback timings are unchanged.
- Keep invalid-recording errors visible and ignore late media events while Android playback is suspended.

## 0.3.10

- Added an initial Android ARM64 beta for Android 8 and newer, including Retroid Pocket Nova controls and larger touch targets. The signed APK includes its own local backend and needs no PC or hosted service.
- Added D-pad focus, A to select, B to go back, X to mute, Y for the guide, L1/R1 for channel changes and Start for theater mode. Android pauses playback and browser timers in the background; scheduled switches require the app in the foreground.
- Added Adult Swim Archive from Spelunkr channel 54's public recording list. Charliflix uses its own rotation, with timing different from Spelunkr's player, automatic trim-aware transitions, current titles, roughly 24 hours of guide listings and scheduled switches.
- Added bounded archive metadata parsing and media URL validation, with direct MP4 playback restricted to archive media hosts. Existing HLS feed choices and fallback remain available for live channels.
- Added repeatable Android signing, APK audits and an Android 13 emulator smoke-test workflow. Android updates use manual APK replacement with the same signing key. Retroid Nova device acceptance remains outstanding.

## 0.3.7

- Added CDNLiveTV as a third feed for ABC, CBS, NBC and FOX, using exact matches from its documented public free catalog.
- Kept the extra feed specific to those four networks; unmatched cable, CW and similarly named news/sports channels are not substituted.
- Added bounded literal-data parsing, exact public player/media routes, channel matching, redirect/DNS guards and isolated resource caches for the new provider.
- Limited automatic fallback startup to 15 seconds per source while retaining 35 seconds for a manual attempt, normal playback recovery and saved manual choices.
- Checked the original site's three extra player slots across all ten channels and documented the unavailable, verification-gated and stale results.

## 0.3.6

- Restored Cartoon Network Player 2 by saving its verified alternate address, avoiding a wrapper that now redirects to the provider's new website.
- Saved the verified alternate addresses for ABC, CBS, FOX and CW, and updated the fallback wrapper resolver to the current site.
- Restored Player 1 for the provider's newly observed edge while retaining exact-origin, redirect, DNS and token restrictions.
- Made automatic fallback explicit: the player names the failed feed and the next attempt, and an exhausted error lists the actual attempt order. Saved manual feed preferences remain unchanged.
- Added regressions for manual Cartoon Network Player 2 selection, fallback history, provider migration and authorization security.

## 0.3.5

- Added a channel guide with local times, current-show labels, and click-to-watch for airing programs.
- Added saved scheduled channel switches from upcoming shows, with cancellation and explicit conflict replacement. Charliflix must remain open; late starts beyond five minutes and ended shows are skipped.
- Added **G** to toggle the guide and **M** to toggle mute. Escape closes the guide before leaving theater mode.
- Added bounded, anonymous EPGTalk listing requests with caching and recovery. The five cable channels use Eastern reference schedules; unidentified network affiliates are explicitly unmatched.
- Kept the guide timeline and scheduled-switch list independently scrollable across narrow and short windows.

## 0.3.4

- Kept the player inside the app window instead of extending the page to fit the channel list.
- Added independent channel scrolling with keyboard access.
- Made the video area, spacing and controls adapt to the available window size while preserving video proportions.
- Added a bounded layout for narrow and short windows, with reachable controls and window-filling theater mode.

## 0.3.3

- Fixed Windows update connections by declaring the executable's .NET Framework 4.8 target, allowing the operating system's modern TLS defaults.
- Added native-process and installed-package checks for the target framework and update transport defaults.
- Windows versions 0.3.0 through 0.3.2 need this installer once because their update connection cannot download the repair. This version also includes the 0.3.2 playback repairs.

## 0.3.2

- Restored Player 1 after its provider introduced short-lived playlist tokens, including renewal during playback and one retry for an expired token.
- Restored Player 2 after its provider moved to a new embed domain.
- Kept playback tokens in memory and restricted their requests to the resolved provider edge.
- Added regression coverage for renewal, concurrent requests, response bounds and provider redirects.

## 0.3.1

- Fixed Windows startup when an older player or another application occupies the local player port.
- Remembered the desktop player's selected local port to keep its settings available across restarts.
- Preserved specific startup errors instead of replacing them with a generic failure message.
- Added an installed-package check that starts the backend, loads the player assets and verifies cleanup while another player remains open.

## 0.3.0

- Added a Windows installer with automatic update checks and background downloads from GitHub Releases.
- Added an explicit Restart to update action, so a download does not interrupt playback.
- Kept managed Windows settings outside versioned application folders.
- Added automatic Mac release notifications; installation remains manual until Apple signing is configured.
- Prevented a new Windows version from reusing an older or different installation's local server.

## 0.2.0

- Added independent Player 1 and Player 2 feed choices, remembered per channel.
- Added bounded fallback when a feed fails or stops delivering video.
- Added a version display and an explicit GitHub release update check.
- Added a portable Windows package with Node included and an Apple Silicon Mac package.
- Added repeatable release builds, checksums and GitHub Actions automation.

Channel availability still depends on the upstream providers. A software update cannot restore a stream that its provider has removed.
