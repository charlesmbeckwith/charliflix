# Changelog

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
