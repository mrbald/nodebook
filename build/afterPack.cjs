const { execFileSync } = require('node:child_process')
const path = require('node:path')

/**
 * Ad-hoc sign macOS builds when no real certificate is configured (CSC_LINK
 * unset). Apple Silicon rejects an *unsigned* arm64 app as "damaged" and won't
 * run it at all; an ad-hoc signature makes it runnable (users still get the
 * normal "unidentified developer" Gatekeeper prompt → Open Anyway, since it's
 * not notarized). With a real cert, electron-builder signs properly and this
 * no-ops.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (process.env.CSC_LINK) return // a real signing identity is present
  const app = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  )
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  console.log(`afterPack: ad-hoc signed ${app}`)
}
