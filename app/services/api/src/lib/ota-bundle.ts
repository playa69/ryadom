import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppServerEnv } from './env'

/**
 * The OTA bundle baked into this image. There is no bucket: `scripts/build-ota-bundle.mjs`
 * builds both native flavours, zips them and writes `manifest.json` next to them; the Dockerfile
 * runs it once and copies the result into the runtime layer as `ota/`.
 * The bundle therefore ships from the same commit and the same deploy as the server - no separate
 * publish step, no second pipeline, no S3 key.
 *
 * `staging` serves the `dev` flavour (it carries the env switcher), `prod` serves `prod`.
 * `local` never has one: `pnpm dev:api` does not run the build step. A missing manifest disables
 * OTA rather than failing startup - a build that skipped the step must still run.
 */

export interface OtaBundle {
  /** `<package.json version>.<pipeline build number>`, matches `isVersionString` in release-policy.ts. */
  version: string
  file: string
  checksum: string
}

interface OtaManifest {
  prod?: OtaBundle
  dev?: OtaBundle
}

function resolveOtaRoot(): string | null {
  // The container (the Dockerfile puts the build next to the server bundle) and a local checkout
  // have different working directories.
  for (const candidate of [join(process.cwd(), 'ota'), join(process.cwd(), 'dist', 'ota')]) {
    if (existsSync(join(candidate, 'manifest.json'))) return candidate
  }
  return null
}

let cached: { root: string; manifest: OtaManifest } | null | undefined

function load(): { root: string; manifest: OtaManifest } | null {
  if (cached !== undefined) return cached
  const root = resolveOtaRoot()
  if (!root) return (cached = null)
  try {
    cached = { root, manifest: JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as OtaManifest }
  } catch {
    // A corrupted manifest must not crash the server: OTA is simply off until the next deploy.
    cached = null
  }
  return cached
}

/** The disk directory the bundle files live in, for the route that serves them. */
export function otaRoot(): string | null {
  return load()?.root ?? null
}

/** `local` never has a bundle; `staging` gets the dev flavour, `prod` gets prod. */
export function otaBundleFor(appEnv: AppServerEnv['APP_ENV']): OtaBundle | null {
  if (appEnv === 'local') return null
  const found = load()
  if (!found) return null
  return found.manifest[appEnv === 'staging' ? 'dev' : 'prod'] ?? null
}

/** Test-only: force a fresh read on the next call instead of the cached manifest. */
export function resetOtaBundleCache(): void {
  cached = undefined
}
