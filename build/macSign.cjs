const { execFileSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { basename, join } = require('node:path')
const { signAsync } = require('@electron/osx-sign')

/**
 * Sign in /tmp then copy back. codesign fails inside some folders
 * (e.g. ~/Documents) with "resource fork / Finder information / detritus"
 * even when xattrs look harmless — signing outside those trees works.
 */
exports.default = async function customSign(opts) {
  const appPath = opts.app
  const appName = basename(appPath)
  const stagingRoot = mkdtempSync(join(tmpdir(), 'fluxagram-sign-'))
  const cleanApp = join(stagingRoot, appName)
  const entitlements = join(__dirname, 'entitlements.mac.plist')

  try {
    execFileSync('ditto', ['--norsrc', '--noextattr', '--noacl', appPath, cleanApp], {
      stdio: 'inherit'
    })

    await signAsync({
      ...opts,
      app: cleanApp,
      identity: opts.identity || '-',
      optionsForFile: () => ({
        entitlements,
        hardenedRuntime: true,
        // Ad-hoc signatures cannot use Apple's timestamp server.
        timestamp: false
      })
    })

    rmSync(appPath, { recursive: true, force: true })
    execFileSync('ditto', [cleanApp, appPath], { stdio: 'inherit' })
    console.log(`[sign] ad-hoc signed via /tmp → ${appPath}`)
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true })
  }
}
