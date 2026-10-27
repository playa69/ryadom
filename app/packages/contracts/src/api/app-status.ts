import type { AppPlatform } from './headers'

/**
 * `GET /api/app-status` — the version policy. Two axes: the native build, updated only through the
 * store, and the JS bundle (OTA), baked into the API image.
 *
 * Open to any version and unauthenticated: this is exactly where an outdated client comes for
 * instructions after a 426. Unusable parameters produce a 400.
 */

export enum UpdateAvailability {
  NotAvailable = 'not_available',
  /** A newer version exists: a banner (native) or a quiet download for the next launch (JS). */
  Available = 'available',
  /** Below the minimum version: a blocking screen (native) or immediate application (JS). */
  Required = 'required',
}

export interface AppStatusApiQuery {
  platform: AppPlatform
  /** The Android versionCode or the iOS build number. */
  version_code: string
  /** JS bundle version. Absent means a client without OTA: the JS axis does not exist for it. */
  js_version?: string
}

export interface AppStatusApiResponse {
  /** The native build: updated only by installing a new version from the store. */
  runtimeUpdate: UpdateAvailability
  /** The current build for this platform. */
  latestVersionCode: number
  /** The store listing for this platform. */
  storeUrl: string | null
  /** Direct link to the latest APK (Android only). */
  downloadUrl: string | null
  /** The JS bundle: updated over the air. */
  jsUpdate: UpdateAvailability
  /**
   * The bundle version the client is supposed to have. The server is the source of truth and the
   * client compares for equality, so rolling a version back is also an "update" (a bundle kill
   * switch).
   */
  jsVersion: string | null
  /** The bundle zip; null when no update is needed or the client's native build cannot run it. */
  jsBundleUrl: string | null
  /** SHA-256 of the zip: the plugin rejects a corrupted or substituted archive. */
  jsBundleChecksum: string | null
}
