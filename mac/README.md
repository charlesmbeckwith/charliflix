# Charliflix for Apple Silicon

Download the Apple Silicon ZIP from [Releases](https://github.com/charlesmbeckwith/charliflix/releases/latest). Release assets use names such as `Charliflix-v0.3.0-Apple-Silicon.zip`; the local build output is `dist/Charliflix-Apple-Silicon.zip`. It contains a self-contained **Charliflix.app** for **M1 or newer Macs running macOS 13 Ventura or newer**, including Chromium, Node.js, the local streaming backend, feed selection and theater mode.

Transfer the ZIP to the Mac and extract it there so macOS executable permissions and framework links are retained. Copy **Charliflix.app** to Applications. The app starts and stops its own loopback backend; no separate Node.js installation is needed. It stores its channel, volume and theater preferences in its own macOS application-data folder.

## Updates

Version 0.3.0 checks GitHub automatically after startup and every four hours while open, then shows a notice when a new release is available. **Check for updates** checks sooner. The Mac app does not download, replace or restart itself to install an update.

To update, download the new Apple Silicon ZIP, quit Charliflix, extract the archive on the Mac and replace the entire **Charliflix.app** in Applications. Preferences are stored outside the app bundle and remain available after replacement. Keep the previous app separately if you want a restore path.

This project has no Apple Developer membership or signing credentials configured. Automatic installation remains disabled until Developer ID signing and notarization are configured and tested. GitHub Releases is sufficient for update hosting; another hosting service is not needed.

## Playback and verification limits

Use the **Feed** menu beside the playback controls to choose a player. The app remembers manual choices per channel, keeps the selector available in theater mode, and tries each available feed once after a playback failure or a sustained stall. Automatic alternatives do not overwrite your saved choice. Missing audio still requires a manual feed switch; multiple players can depend on the same upstream service and fail together.

This is an **ad-hoc-signed, unnotarized personal test build**. It does not have an Apple Developer ID signature. macOS may block it. Apple signing/notarization and a real Mac launch test are still required for a normal trusted distribution release. The package does not disable Gatekeeper or remove quarantine attributes.

Validation on Windows/Linux includes application regression tests, exact packaged-source comparisons, ARM64 architecture, all 13 Mach-O code signatures' page and special-slot hashes, bundle resource hashes, helper executable names, executable permissions, ZIP CRCs and all 14 framework symlinks. A deliberate code mutation was rejected by the hash validator. Actual Mac launch, playback, audio/fullscreen and Apple's `codesign --verify --deep --strict` remain untested.

The cross-platform signing tool's `verify` command reports its known empty-CMS parsing error for ad-hoc signatures. This result is retained in the archive verification JSON; it is not reported as a passing Apple signature check. Independent digest checks verify every CodeDirectory page, embedded entitlement/requirement slot and external Info.plist/CodeResources binding instead.

## Build from source

Rebuild on this Windows PC with `mac/Build-Mac.ps1`. It uses the existing Ubuntu-24.04 WSL environment, Python 3.12+, pinned checksum-verified Electron 44.7.2 and rcodesign 0.29.0 archives, and the source in this folder. It signs on a temporary POSIX filesystem, preserves links and modes in the ZIP, and removes temporary build files afterward. The build does not use Apple credentials or upload the app.

`dist/Charliflix-Apple-Silicon.verification.json` records the exact checks and remaining verification limits. The adjacent `.zip.sha256` file records the archive checksum.

After a rebuild and a successful application test run, run `python mac/audit_archive.py --application-tests COUNT`, replacing `COUNT` with that run's passing test count. It independently checks the shipped ZIP's code pages, special slots, resource and nested-code seals, framework links and executable modes, then compares all runtime source files against the current workspace. The results are saved in `mac/verification.json`.
