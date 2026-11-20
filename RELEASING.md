# Publish a Nodebook release

The Release workflow builds Nodebook for Apple silicon, Intel Macs, Windows and Linux. A version tag creates a draft on GitHub. Check the downloads before you publish the draft. [Release workflow](.github/workflows/release.yml)

## Prepare the version

1. Choose an unused version. Set it in `package.json` and the root package entries in `package-lock.json`.
2. Open a pull request from a `release/` branch in this repository. Wait for CI, Security and the four Release builds to pass. Merge the pull request.
3. Tag the merged commit with the version from `package.json`. For version `1.2.3`, run `git tag v1.2.3 <commit>`, replacing `<commit>` with the merged commit ID. Push that tag with `git push origin refs/tags/v1.2.3`.

macOS builds use ad-hoc signing and need no Apple Developer credentials. For optional Windows signing, set the GitHub secrets `WIN_CSC_LINK` (a base64-encoded PFX) and `WIN_CSC_KEY_PASSWORD`.

## Check the draft

1. Wait for the tagged workflow to finish. The Mac jobs run on the architectures they ship. Each checks the signature and architecture, then opens and searches a temporary vault using the app from both the DMG and the ZIP. This check uses test vectors to exercise the packaged SQLite extension.
2. Open the draft in GitHub Releases. Look for an arm64 DMG and ZIP, an x64 DMG and ZIP, a Windows installer and portable executable, a Linux AppImage and a Debian package. The workflow downloads the draft assets and compares them with the tested files.
3. On a fresh Mac or macOS VM, sign in to GitHub and download the draft DMG in Safari. Drag Nodebook to Applications and open it. If macOS cannot verify the developer, dismiss the alert. In **System Settings → Privacy & Security**, choose **Open Anyway** for this copy, then open a test vault. Record the macOS version and the prompts you saw. Stop the release if macOS reports damage or malware. [Apple’s instructions](https://support.apple.com/en-us/102445)
4. Keep the Mac first-launch instructions in the release notes. Publish the draft and verify that a signed-out visitor can download the installer.

If an upload stops partway through, rerun the draft job. If its asset check finds a mismatch, inspect the draft, remove the incomplete draft while keeping its tag, and rerun the job with the original build artifacts. To replace an already published release, choose a new version.

## Test a local Mac package

From the repository root, install dependencies with `npm ci`. Build the package, then point Playwright at its executable. Adjust the path for an Intel build. The test uses a temporary profile and vault.

```sh
npm run pack
NODEBOOK_SMOKE_BINARY="$PWD/dist/mac-arm64/Nodebook.app/Contents/MacOS/Nodebook" npx playwright test e2e/talk.spec.ts
```

## Dependency updates

Dependabot checks npm, GitHub Actions and the pre-commit hook every day at 05:00 UTC. New versions must be at least five days old. Security fixes can appear as PRs sooner. CI checks publication dates before npm installs from the lockfile, including indirect dependencies.

GitHub can squash-merge a Dependabot PR when it is up to date with `main` and passes the tests, security scans and native package builds. Review a failing check on the PR. Local npm updates use the same release-age setting with npm 11.10 or later.
