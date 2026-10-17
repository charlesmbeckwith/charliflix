# Releasing Charliflix

The root `package.json` version is the source of truth for the interface and both desktop packages.

1. Update the stable `X.Y.Z` version in `package.json` and the two root version entries in `package-lock.json`.
2. Update `CHANGELOG.md`, then run `npm ci` and `npm test`.
3. Commit the change to `main`, create the matching `vX.Y.Z` tag, and push the commit and tag.
4. GitHub Actions tests the source, builds the Windows installer/update packages and both platform archives, and publishes them with `SHA256SUMS` after successful builds.

Inspect the workflow run before sharing the release. Tagging a version does not make upstream TV feeds available. Avoid placing browser profiles, tokens, diagnostic captures or downloaded TV segments in source control or release archives.

Windows automatic updates use Velopack's public GitHub source. Keep the installer, full update package and `releases.win.json` in each release. Do not rename updater assets after packaging. Managed installs check and download while open, then apply and restart only on the explicit user action. The legacy portable ZIP and developer checkout remain manual.

Windows packages include Node and require .NET Framework 4.8 and Microsoft WebView2 Evergreen. Managed runtime data and WebView2 settings live under `%LOCALAPPDATA%/Charliflix/user-data`, outside the versioned app directory. Portable users should close all instances and any separately started browser server before extracting an update; preserve the portable `.runtime` folder. Mac preferences live outside the app bundle, so replacing the whole app preserves them.

Mac builds are currently ad-hoc signed and unnotarized. They check for releases automatically but require manual replacement. Developer ID signing, notarization and a real Mac launch/playback/update check remain necessary before enabling automatic installation. The project owner has not configured Apple membership or credentials. No additional paid update-hosting service is required; GitHub Releases hosts the assets. Do not add instructions that disable Gatekeeper or remove quarantine attributes.
