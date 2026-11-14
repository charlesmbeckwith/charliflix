# Releasing Charliflix

The root `package.json` version is the source of truth for the interface, both desktop packages and the Android APK.

1. Update the stable `X.Y.Z` version in `package.json` and the two root version entries in `package-lock.json`.
2. Update `CHANGELOG.md`, then run `npm ci` and `npm test`.
3. Commit the change to `main`, create the matching `vX.Y.Z` tag, and push the commit and tag.
4. GitHub Actions tests the source, builds the Windows installer/update packages, both desktop archives and the signed Android ARM64 APK, and publishes them with `SHA256SUMS` after successful builds.

Inspect the workflow run before sharing the release. Tagging a version does not make upstream TV feeds available. Avoid placing browser profiles, tokens, diagnostic captures or downloaded TV segments in source control or release archives.

The Windows release job installs Setup on its disposable runner and checks the managed native host and Start menu shortcut. It also starts the installed backend while an older player occupies the preferred port, loads the player assets over HTTP, verifies the saved origin survives a restart, and confirms owned-backend cleanup. This does not replace a WebView playback or real feed availability check.

The reusable [Android workflow](.github/workflows/android.yml) builds and lints the signed ARM64 APK, checks its certificate, alignment, package/version metadata and embedded source hashes, then runs an x86-64 test edition in a disposable Android 13 emulator. Tests cover embedded Node startup, local HTTP assets, WebView loading, navigation policy, activity recreation, stored theme/history restoration, controlled PiP lifecycle, and long-text bounds in landscape and portrait. Inspect the actual workflow result, layout screenshots and published verification JSON before claiming those checks passed. The PiP test supplies a controlled eligibility fixture; it is not actual ARM64 stream playback, controller testing or Retroid Nova device acceptance. Android remains a beta; the embedded Node 24 mobile build is also an upstream prerelease.

Android signing uses the retained private key with encrypted GitHub Actions secrets: `CHARLIFLIX_ANDROID_KEYSTORE_BASE64`, `CHARLIFLIX_ANDROID_KEYSTORE_PASSWORD`, `CHARLIFLIX_ANDROID_KEY_PASSWORD` and `CHARLIFLIX_ANDROID_KEY_ALIAS`. The workflow materializes the key only in its temporary directory and removes it afterward. Local builds additionally use `CHARLIFLIX_ANDROID_KEYSTORE` for the key's path. Preserve a secure backup of the ignored `android/.signing/` key and its credentials: changing or losing the signer prevents an ordinary update over the existing package. Never commit the key, print its values or publish a debug APK. See [Android build instructions](android/README.md).

Each Android release includes `Charliflix-vX.Y.Z-Android-arm64.apk` and its verification JSON; the APK checksum is included in the release's `SHA256SUMS`. Keep package ID `com.charliflix.player`, the retained signer and increasing version codes. Users download and install the new APK over the existing app to preserve settings; Android installation remains explicit and manual. No paid hosting service is required.

Windows automatic updates use Velopack's public GitHub source. Keep the installer, full update package and `releases.win.json` in each release. Do not rename updater assets after packaging. Managed installs check and download while open, then apply and restart only on the explicit user action. The legacy portable ZIP and developer checkout remain manual.

Windows packages include Node and require .NET Framework 4.8 and Microsoft WebView2 Evergreen. Managed runtime data and WebView2 settings live under `%LOCALAPPDATA%/Charliflix/user-data`, outside the versioned app directory. Portable users should close all instances and any separately started browser server before extracting an update; preserve the portable `.runtime` folder. Mac preferences live outside the app bundle, so replacing the whole app preserves them.

Mac builds are currently ad-hoc signed and unnotarized. They check for releases automatically but require manual replacement. Developer ID signing, notarization and a real Mac launch/playback/update check remain necessary before enabling automatic installation. The project owner has not configured Apple membership or credentials. No additional paid update-hosting service is required; GitHub Releases hosts the assets. Do not add instructions that disable Gatekeeper or remove quarantine attributes.

Spelunkr source verification establishes public recording-list access and tested H.264/AAC MP4 media, not rights clearance. Adult Swim Archive uses Charliflix's own rotation rather than claiming synchronization with Spelunkr channel 54. Retain that distinction in the interface, guide, documentation and release notes.
