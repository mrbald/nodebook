# Releasing Nodebook

A version tag builds a draft GitHub Release. Each macOS job runs on the
architecture it ships, Apple silicon or Intel. The same ad-hoc signing hook
signs the app for local packages and GitHub releases. macOS releases use a
per-app first-launch exception and require no Apple Developer credentials.

Windows optionally uses `WIN_CSC_LINK` (base64-encoded `.pfx`) and
`WIN_CSC_KEY_PASSWORD`.

## Cut and verify a release

1. Choose an unused version matching `package.json` and the root entries of
   `package-lock.json`. Open a pull request from a `release/` branch in this
   repository. Check CI, Security and all four platform builds before merging.
2. Tag that commit and push only its release tag. For example, for version
   `1.2.3`, use `git tag v1.2.3 <commit>` and `git push origin refs/tags/v1.2.3`.
3. Wait for the **Release** workflow. It verifies the ad-hoc signature and
   native architecture, then opens a disposable vault with semantic search
   in the app from **both** Mac formats.
4. The workflow downloads the draft's GitHub assets and compares their bytes
   with the tested build outputs. Review the draft in GitHub Releases. Expect
   `Nodebook-<version>-arm64.dmg` and `.zip` for Apple silicon, the `x64` pair
   for Intel, Windows `-setup.exe` and `-portable.exe`, an AppImage and a
   Debian package. Keep the macOS first-launch instructions beside the assets.
5. Download the draft DMG in Safari while signed in to GitHub. On a fresh Mac
   or macOS VM, drag Nodebook to Applications and try to open it. If macOS
   says it can't verify Nodebook, dismiss the alert and select **Open Anyway**
   for Nodebook in **System Settings → Privacy & Security**. Confirm the prompt
   and open a test vault. Record the macOS version and first-launch prompts.
   A damaged-app or malware alert is a release failure. [Apple’s first-launch instructions](https://support.apple.com/en-us/102445)
6. Publish the verified draft and confirm the installer downloads from the
   public release while signed out of GitHub.

If a draft upload was interrupted, rerun the draft job to verify a complete
upload. If the asset set differs, inspect that draft, discard the incomplete
draft while keeping its tag, then rerun the job using the original build
artifacts. A published tag gets a new version for a replacement release.

## Check a local package

Run the packaged search test against the executable inside the bundle. This
loads the real SQLite extension using an isolated profile and fixture vault.

```sh
NODEBOOK_SMOKE_BINARY="$PWD/dist/mac-arm64/Nodebook.app/Contents/MacOS/Nodebook" npx playwright test e2e/talk.spec.ts
```

## Dependency updates

Dependabot checks npm, GitHub Actions and the pre-commit hook every day at 05:00 UTC. New versions must be at least five days old. Security fixes can appear as PRs sooner. CI checks publication dates before npm installs from the lockfile, including indirect dependencies.

GitHub can squash-merge a Dependabot PR when it is up to date with `main` and passes the tests, security scans and native package builds. Review a failing check on the PR. Local npm updates use the same release-age setting with npm 11.10 or later.
