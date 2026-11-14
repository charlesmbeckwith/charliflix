# Charliflix for Android

The initial Android release is an **ARM64 beta**, intended to include the Retroid Pocket Nova. It requires Android 8/API 26 or newer and uses Android System WebView for the interface and video. The APK bundles the existing player, stream adapters and a local Node backend; it does not require a PC, Termux, a server account or a paid service.

Actual launch, sound, playback and controller behavior on the Nova still need device verification. The APK's build and emulator checks do not establish that acceptance.

## Install and update

1. On the Nova, open [Charliflix Releases](https://github.com/charlesmbeckwith/charliflix/releases/latest) and download **Charliflix-v0.3.11-Android-arm64.apk**.
2. Open the downloaded APK. If Android asks, allow this browser or file manager to install the downloaded app, then approve installation.
3. Open **Charliflix** from the launcher and choose a channel.

For future versions, use **Check for updates** in Charliflix, download the release's **Android-arm64.apk**, and install it over the existing app. **Do not uninstall first**; an update with the same package ID and signing key preserves app settings and scheduled switches. Android asks you to approve installation. This beta does not silently install updates or use a background updater service.

## Controls and background behavior

| Nova control | Action |
| --- | --- |
| D-pad | Move focus between channels and controls |
| A | Select the focused button or link |
| B | Leave fullscreen, close the guide, leave theater, then leave the app |
| X | Toggle mute |
| Y | Open or close the guide |
| L1 / R1 | Previous / next channel, while the guide is closed |
| Start | Toggle theater mode |

Touch controls remain available. Feed selection and volume use their normal control behavior. The lineup scrolls independently from the video.

Android pauses playback and browser timers when Charliflix goes into the background. **Keep it in the foreground for scheduled channel changes.** It does not wake the device or start itself. On returning, tap Play; an expired archive block resumes at the current rotation rather than replaying the missed block. The existing five-minute late-start rule applies to scheduled switches after resuming.

Adult Swim Archive uses the public recording list from [Spelunkr channel 54](https://spelunkr.tv/) and **Charliflix's own rotation**. Its timing differs from Spelunkr's player. Current titles, approximately 24 hours of archive listings and scheduled switches describe that rotation. Source availability and technical checks are not rights clearance.

## Runtime and application boundaries

The native shell is a Java Activity with Android WebView and a small JNI bridge. It embeds [fogtape/nodejs-mobile](https://github.com/fogtape/nodejs-mobile), pinned to **24.22.1-0**, based on Node 24.22.1. This maintained mobile fork is an upstream prerelease, so the first Android distribution remains a beta. The runtime archive and Gradle distribution are pinned by SHA-256 in `build.py`.

The backend binds to loopback inside the app. The shell permits the local player, bounded archive MP4 playback and approved attribution/release links; provider advertising pages are not embedded. The APK requests Internet access. It does not install a background service. Android permits cleartext only for the local player connection; upstream sources use HTTPS. Dependency licenses are included in the APK assets.

## Build from source

Use a full **JDK 17**, Python 3, Node 22 or newer for the build tools, and an Android SDK exposed through `ANDROID_HOME` (or the supported `ANDROID_SDK_ROOT` fallback). The release workflow uses Ubuntu 24.04. Required SDK components are:

- Platform and build tools **35 / 35.0.0**; the app targets API 35 and has minimum API 26.
- NDK **28.0.13004108**.
- CMake **3.22.1**.
- For CI smoke tests: Android emulator and `system-images;android-33;google_apis;x86_64`.

The build helper downloads SHA-256-checked Node mobile and Gradle **8.11.1** archives with `--fetch`. Android Gradle Plugin is pinned in `build.gradle`. Install the listed SDK components and accept their licenses before building.

From the repository root:

```sh
npm ci
npm test
python3 android/build.py --fetch
python3 android/audit.py
```

A release build requires the retained Charliflix signing key through these environment variables. Supply their values through the local secret mechanism, without placing passwords in source or command examples.

| Variable | Purpose |
| --- | --- |
| `CHARLIFLIX_ANDROID_KEYSTORE` | Absolute path to the retained local keystore |
| `CHARLIFLIX_ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `CHARLIFLIX_ANDROID_KEY_ALIAS` | Signing key alias |
| `CHARLIFLIX_ANDROID_KEY_PASSWORD` | Signing key password |

The owner's local signing material is kept under ignored `android/.signing/`. Keep a secure backup of both the key and its credentials. Release CI receives the same key through the encrypted `CHARLIFLIX_ANDROID_KEYSTORE_BASE64` secret plus the three credential secrets above; that base64 secret is not needed for an ordinary local build. Never publish the private key, generated payload directories or signing credentials.

The version comes from the root `package.json`; generated `version.properties` maps `X.Y.Z` to Android version code `X * 1000000 + Y * 1000 + Z`. Outputs are under `dist/`:

- `Charliflix-vX.Y.Z-Android-arm64.apk`
- `Charliflix-vX.Y.Z-Android-arm64.verification.json`
- `Charliflix-vX.Y.Z-Android-arm64.apk.sha256`

The audit checks the signature, non-debuggable package identity, ARM64 native payload, 16 KiB ZIP alignment and hashes of embedded player files. The [release workflow](../.github/workflows/release.yml) includes these assets and combines checksums into `SHA256SUMS` after all platform jobs pass.

For development without the release signer:

```sh
python3 android/build.py --fetch --debug
```

This creates the separate `com.charliflix.player.debug` app. Never distribute it as the normal release or use its certificate for release updates. `--abi x86_64 --debug` builds the separate emulator test edition; it is not the Nova APK.

## Verification limits

The [Android workflow](../.github/workflows/android.yml) is configured to build and lint the signed ARM64 APK, audit its contents, and run an x86-64 debug edition in an Android 13 emulator. Its smoke test checks native Node startup, local HTTP assets, WebView loading, navigation policy and activity recreation. A successful workflow is recorded in the release verification JSON; inspect that result before claiming a particular release passed.

The emulator check does not test actual ARM64 Nova playback, physical buttons, audio output or sustained streaming. Those remain device checks. Independent archive media inspection verified H.264 video with AAC audio; feed availability can still change after a release.
