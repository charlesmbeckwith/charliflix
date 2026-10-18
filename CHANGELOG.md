# Changelog

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
