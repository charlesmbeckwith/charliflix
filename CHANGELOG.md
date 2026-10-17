# Changelog

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
