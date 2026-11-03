#!/usr/bin/env node
/**
 * Puts the team debug key into android/keystores/debug.keystore (git-ignored), so debug builds from every
 * machine carry one signature: a RuStore push project accepts a single SHA-256 fingerprint.
 *
 *   pnpm android:debug-key           the active yc profile
 *   YC_PROFILE=<name> pnpm android:debug-key
 *
 * Runbook: android/README.md.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Lockbox secret ryadom-app-secrets, addressed by id so the profile's default folder does not matter.
const SECRET_ID = 'e6qlbsdv554cav7urkn2'
const ENTRY = 'ANDROID_DEBUG_KEYSTORE'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'android', 'keystores', 'debug.keystore')

const args = ['lockbox', 'payload', 'get', '--id', SECRET_ID, '--key', ENTRY]
if (process.env.YC_PROFILE) args.unshift('--profile', process.env.YC_PROFILE)

const result = spawnSync('yc', args, { encoding: 'utf8' })
if (result.error || result.status !== 0) {
  console.error(`yc ${args.join(' ')} failed: ${result.error?.message ?? result.stderr.trim()}`)
  console.error(
    'Needs the yc CLI, a logged-in profile and read access to the Lockbox secret (android/README.md).',
  )
  process.exit(1)
}

const keystore = Buffer.from(result.stdout.trim(), 'base64')
// A PKCS#12 store is a DER SEQUENCE; anything else means the entry holds something other than the key.
if (keystore.length === 0 || keystore[0] !== 0x30) {
  console.error(`Lockbox entry ${ENTRY} is not a base64-encoded keystore`)
  process.exit(1)
}

mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, keystore)
console.log(`Team debug key written to ${target}`)
console.log(
  'Check it: cd android && ./gradlew :app:signingReport  (debug variants: SHA-256 CD:53:25:4E:…:F0:92:D6)',
)
