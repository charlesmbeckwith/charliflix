# Releasing Charliflix

The root `package.json` version is the source of truth for the interface and both desktop packages.

1. Update the stable `X.Y.Z` version in `package.json` and the two root version entries in `package-lock.json`.
2. Update `CHANGELOG.md`, then run `npm ci` and `npm test`.
3. Commit the change to `main`, create the matching `vX.Y.Z` tag, and push the commit and tag.
4. GitHub Actions tests the source, builds Windows x64 and Apple Silicon packages, and publishes both archives with `SHA256SUMS` after successful builds.

Inspect the workflow run before sharing the release. Tagging a version does not make upstream TV feeds available. Avoid placing browser profiles, tokens, diagnostic captures or downloaded TV segments in source control or release archives.

The initial update flow checks the public repository's latest stable release. Users download and replace the app manually; it does not silently install or execute downloaded code. The apps only open release pages under this project's exact GitHub repository.

Windows packages include Node and require .NET Framework 4.8 and Microsoft WebView2 Evergreen. Close Charliflix, then extract an update over the existing folder to preserve `.runtime/desktop-profile` settings. Keep a copy of the old folder if you need to restore it. Mac preferences live outside the app bundle, so replacing the whole app preserves them.

Mac builds are currently ad-hoc signed and unnotarized. A real Mac launch and playback check, Developer ID signing and notarization remain necessary for a smooth public distribution experience. Do not add instructions that disable Gatekeeper or remove quarantine attributes.
