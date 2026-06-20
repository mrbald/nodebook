# Releasing Nodebook

## Cutting a release

1. Bump the version in `package.json` (e.g. `0.1.0`).
2. Commit, then tag and push the tag:
   ```sh
   git commit -am "release: v0.1.0"
   git tag v0.1.0
   git push origin main --tags
   ```
3. `.github/workflows/release.yml` fans out across macOS, Windows and Linux,
   builds with `electron-builder`, and publishes every artifact to a single
   **GitHub Release** for the tag.

Artifacts per OS: macOS `.dmg` + `.zip` (x64 & arm64), Windows NSIS installer +
portable `.exe`, Linux `AppImage` + `.deb`.

`CI` (`.github/workflows/ci.yml`) runs typecheck + unit + Electron e2e (under
xvfb) on every push/PR to `main`.

## Code signing (optional but recommended)

Without the secrets below, releases build **unsigned** and the pipeline still
succeeds — macOS users right-click → Open once, Windows shows a SmartScreen
warning. Add the secrets to enable signing; no workflow edits needed.

### macOS — sign + notarize
Requires an Apple Developer account ($99/yr). Export a **Developer ID
Application** certificate as a `.p12`, then add repo secrets:

| Secret | Value |
| --- | --- |
| `MAC_CSC_LINK` | `base64 -i cert.p12` (the cert, base64-encoded) |
| `MAC_CSC_KEY_PASSWORD` | the `.p12` export password |
| `APPLE_ID` | your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | an app-specific password (appleid.apple.com) |
| `APPLE_TEAM_ID` | your 10-char Apple Team ID |

Then flip `mac.notarize: true` in `electron-builder.yml` to enable
notarization (leave it `false` until the Apple secrets exist, or the build
fails on a missing credential).

### Windows — sign
Requires a code-signing certificate (OV/EV from a CA, exported as `.pfx`):

| Secret | Value |
| --- | --- |
| `WIN_CSC_LINK` | `base64 -i cert.pfx` |
| `WIN_CSC_KEY_PASSWORD` | the `.pfx` password |

Linux needs no signing.

## TODO before a polished 1.0
- Add app icons under `build/`: `icon.icns` (mac), `icon.ico` (win),
  `icon.png` 512×512 (linux). Until then electron-builder uses a default icon.
- Optional: `electron-updater` + the GitHub Releases feed for in-app auto-update.
