import { UpdateAvailability, type AppStatusApiResponse } from '@ryadom/contracts/api/app-status'
import { AppPlatform } from '@ryadom/contracts/api/headers'
import { otaBundlePath } from '@ryadom/contracts/api/paths'
import { otaBundleFor } from './ota-bundle'
import type { AppServerEnv } from './env'

/**
 * Version policy: two axes, two owners, no bucket.
 *
 * - **JS/OTA** ships in step with the server - same commit, same deploy, same image - so it is
 *   baked in (`lib/ota-bundle.ts`) rather than read from anywhere at runtime.
 * - **Native** (store min/latest build, store links) changes only on a store release, which does
 *   not happen in step with a deploy - RuStore takes hours, App Store up to three days of review -
 *   so it stays in env, meant for a ConfigMap the release process edits by hand.
 *
 * `buildReleasePolicy` runs once at startup: both sources are already fixed for the life of the
 * process (env is a pod's spec, the bundle is baked into its image), so there is nothing to poll.
 */

export interface NativePolicy {
  minVersionCode: number
  latestVersionCode: number
  downloadUrl: string | null
}

export interface JsPolicy {
  latestVersion: string | null
  bundleUrl: string | null
  checksum: string | null
}

export interface ReleasePolicy {
  android: NativePolicy
  ios: NativePolicy
  js: JsPolicy
}

const EMPTY_NATIVE: NativePolicy = { minVersionCode: 0, latestVersionCode: 0, downloadUrl: null }

export const EMPTY_POLICY: ReleasePolicy = {
  android: EMPTY_NATIVE,
  ios: EMPTY_NATIVE,
  js: { latestVersion: null, bundleUrl: null, checksum: null },
}

/**
 * A shipped bundle needs a native capability (a new Capacitor plugin, a new permission) only from
 * this build on: bump by hand, in the same commit that adds the native dependency, rather than
 * through a manual release-time input. Native changes are rare (on milestones, once
 * a month or two), so this changes about as often as the native axis in env does, and travels
 * with the code that needs it instead of being typed into a form.
 */
const OTA_MIN_NATIVE_BUILD: Partial<Record<AppPlatform, number>> = {}

/** JS bundle version, such as "1.2.3". One definition for the gate and the manifest. */
const VERSION_RE = /^\d{1,6}(\.\d{1,6}){0,3}$/

export function isVersionString(value: string): boolean {
  return VERSION_RE.test(value)
}

/** versionCode from a header or query parameter: digits only, otherwise null. */
export function parseVersionCode(raw: string | null | undefined): number | null {
  const value = raw?.trim() ?? ''
  return /^\d{1,10}$/.test(value) ? Number(value) : null
}

/** JS version from the header: absent is null, and garbage compares as 0, so the client is outdated. */
export function parseJsVersion(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const value = raw.trim()
  return isVersionString(value) ? value : '0'
}

/** Compare versions segment by segment as numbers; string comparison is a trap ('1.0.10' < '1.0.9'). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

function nativeOf(env: AppServerEnv, platform: AppPlatform): NativePolicy {
  return platform === AppPlatform.Ios
    ? {
        minVersionCode: env.MOBILE_IOS_MIN_VERSION_CODE,
        latestVersionCode: env.MOBILE_IOS_LATEST_VERSION_CODE,
        downloadUrl: null,
      }
    : {
        minVersionCode: env.MOBILE_ANDROID_MIN_VERSION_CODE,
        latestVersionCode: env.MOBILE_ANDROID_LATEST_VERSION_CODE,
        downloadUrl: env.MOBILE_ANDROID_DOWNLOAD_URL ?? null,
      }
}

/** The policy for this process: native axis from env, JS axis from the bundle baked into the image. */
export function buildReleasePolicy(env: AppServerEnv): ReleasePolicy {
  const bundle = otaBundleFor(env.APP_ENV)
  return {
    android: nativeOf(env, AppPlatform.Android),
    ios: nativeOf(env, AppPlatform.Ios),
    js: bundle
      ? {
          latestVersion: bundle.version,
          bundleUrl: `${env.PUBLIC_APP_URL}${otaBundlePath(bundle.file)}`,
          checksum: bundle.checksum,
        }
      : EMPTY_POLICY.js,
  }
}

export interface PolicySource {
  get(): ReleasePolicy
}

/** Computed once at startup; see the module comment for why nothing here needs to be re-read. */
export function createPolicySource(env: AppServerEnv): PolicySource {
  const policy = buildReleasePolicy(env)
  return { get: () => policy }
}

export interface ClientVersions {
  platform: AppPlatform
  versionCode: number
  /** null means a client without OTA: the JS axis does not exist for it. */
  jsVersion: string | null
}

function policyNativeOf(policy: ReleasePolicy, platform: AppPlatform): NativePolicy {
  return platform === AppPlatform.Ios ? policy.ios : policy.android
}

/**
 * The behaviour matrix is a pure function so that it can be exercised in tests without touching env
 * or disk. Two axes: the native build wins on its own, and a bundle rollback (redeploying a prior
 * image, whose baked-in version is then older than what some clients already applied) is picked up
 * and applied immediately - the image itself is the kill switch, nothing here needs to know about it.
 *
 * `minNativeBuild` defaults to the constant above; tests pass their own map to exercise the gating
 * branch without waiting for a real native dependency to justify bumping it.
 */
export function resolveAppStatus(
  policy: ReleasePolicy,
  client: ClientVersions,
  storeUrl: string | null,
  minNativeBuild: Partial<Record<AppPlatform, number>> = OTA_MIN_NATIVE_BUILD,
): AppStatusApiResponse {
  const native = policyNativeOf(policy, client.platform)
  const latestJs = policy.js.latestVersion
  // The bundle is offered only to a native build that can run it (it carries the new plugin).
  const bundleReachable = latestJs !== null && client.versionCode >= (minNativeBuild[client.platform] ?? 0)

  const runtimeUpdate =
    client.versionCode < native.minVersionCode
      ? UpdateAvailability.Required
      : client.versionCode < native.latestVersionCode
        ? UpdateAvailability.Available
        : UpdateAvailability.NotAvailable

  let jsUpdate = UpdateAvailability.NotAvailable
  if (client.jsVersion !== null && bundleReachable && latestJs !== null) {
    const cmp = compareVersions(client.jsVersion, latestJs)
    if (cmp < 0) jsUpdate = UpdateAvailability.Available
    // A client newer than the server means a broken bundle is being rolled back: apply at once.
    else if (cmp > 0) jsUpdate = UpdateAvailability.Required
  }

  const offered = jsUpdate !== UpdateAvailability.NotAvailable
  return {
    runtimeUpdate,
    latestVersionCode: native.latestVersionCode,
    storeUrl,
    downloadUrl: native.downloadUrl,
    jsUpdate,
    jsVersion: latestJs,
    jsBundleUrl: offered ? policy.js.bundleUrl : null,
    jsBundleChecksum: offered ? policy.js.checksum : null,
  }
}

/**
 * Whether to let a client reach the API. Only the native minimum cuts a client off; JS staleness
 * alone never does, because it heals itself on the next launch without anyone being locked out.
 */
export function isClientAllowed(policy: ReleasePolicy, client: ClientVersions): boolean {
  return client.versionCode >= policyNativeOf(policy, client.platform).minVersionCode
}
