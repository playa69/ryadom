import { App } from '@capacitor/app'
import { UpdateAvailability, type AppStatusApiResponse } from '@ryadom/contracts/api/app-status'
import type { ApiEnvelope } from '@ryadom/contracts/api/envelope'
import { AppHeader, AppPlatform } from '@ryadom/contracts/api/headers'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { reportAppUpdate } from './analytics'
import { getVersionInfo } from './device'
import { getApiBase, getEnvId } from './env'
import { onNetworkChange } from './native'
import { isIosNative, isNative, isWebBuild } from './platform'
import { initServiceWorker } from './service-worker'

/**
 * Client side of the version policy: polls /api/app-status, downloads and applies
 * OTA bundles, and reports the blocking screen or the update banner to AppUpdateGate through an
 * event.
 *
 * Must not import platform-adapter.ts, api.ts or auth.ts: platform-adapter.ts imports this module
 * (for the version headers and the 426 hook) and the other two import platform-adapter.ts, so any of
 * them here would close a cycle. It fetches the status directly. Native builds only: the web build
 * uses a service worker instead.
 */

/** Version of this JS bundle: `version` from package.json at the time it was built. */
const JS_VERSION = __APP_VERSION__

const LAST_VERSION_CODE_KEY = 'ryadom.update.lastVersionCode'
const NEXT_BUNDLE_KEY = 'ryadom.update.nextJsVersion'
const BANNER_DISMISSED_KEY = 'ryadom.update.dismissedVersionCode'

// ─── UI state (AppUpdateGate listens) ─────────────────────────────────────────

export const APP_UPDATE_EVENT = 'ryadom:update-state'

export type UpdateUiState =
  | { kind: 'none' }
  /** The build is below the minimum: the screen is blocked, the only way out is a new build. */
  | { kind: 'store-required'; storeUrl: string | null; downloadUrl: string | null }
  /** A newer build exists: an unobtrusive banner. */
  | { kind: 'store-banner'; storeUrl: string | null; downloadUrl: string | null; versionCode: number }
  /** A mandatory JS bundle is downloading and is about to restart the WebView. */
  | { kind: 'js-updating' }
  /** A mandatory update is waiting for a critical operation to finish. */
  | { kind: 'pending' }
  /** Web build: a new service worker is installed and waiting to activate (lib/service-worker.ts). */
  | { kind: 'web-update' }

function emit(state: UpdateUiState): void {
  window.dispatchEvent(new CustomEvent<UpdateUiState>(APP_UPDATE_EVENT, { detail: state }))
}

// ─── client versions ──────────────────────────────────────────────────────────

/** Android and iOS have separate version policies. */
function currentPlatform(): AppPlatform {
  return isIosNative() ? AppPlatform.Ios : AppPlatform.Android
}

/**
 * Whether this build is on its own OTA channel. Bundles are built per flavour: prod serves prod
 * bundles, staging serves dev bundles. A dev build pointed at prod must not pick up a foreign
 * bundle, and must not send its JS version there either, or a foreign minimum could lock it out.
 */
function otaEnabled(): boolean {
  if (!isNative()) return false
  return import.meta.env.VITE_FLAVOR === 'prod' || getEnvId() === 'staging'
}

/**
 * Version headers for every API request; the server version gate reads them. Empty in a
 * browser, where the server does not check requests that carry no headers.
 */
export async function getVersionHeaders(): Promise<Record<string, string>> {
  if (!isNative()) return {}
  const { versionCode } = await getVersionInfo()
  if (versionCode === null) return {}
  return {
    [AppHeader.Platform]: currentPlatform(),
    [AppHeader.AppVersion]: String(versionCode),
    ...(otaEnabled() ? { [AppHeader.JsVersion]: JS_VERSION } : {}),
  }
}

// ─── critical operations ──────────────────────────────────────────────────────

let criticalOps = 0
let pendingRequired: AppStatusApiResponse | null = null

/**
 * A mandatory update must not restart the WebView in the middle of a photo
 * upload or a message being sent: operations wrapped here defer applying it
 * until they finish.
 */
export async function withCriticalOperation<T>(operation: () => Promise<T>): Promise<T> {
  criticalOps++
  try {
    return await operation()
  } finally {
    criticalOps--
    if (criticalOps === 0 && pendingRequired) {
      const status = pendingRequired
      pendingRequired = null
      void applyRequired(status)
    }
  }
}

// ─── status check ─────────────────────────────────────────────────────────────

export type CheckTrigger = 'launch' | 'resume' | 'network' | 'http-426'

// resume and network fire often, so at most once a minute; launch and 426 always run.
const ROUTINE_THROTTLE_MS = 60_000

let inFlight: Promise<void> | null = null
let lastCheckAt = 0
let firstRunAfterNativeUpdate = false

export function checkAppStatus(trigger: CheckTrigger): Promise<void> {
  if (!isNative()) return Promise.resolve()
  if ((trigger === 'resume' || trigger === 'network') && Date.now() - lastCheckAt < ROUTINE_THROTTLE_MS) {
    return Promise.resolve()
  }
  if (inFlight) return inFlight
  inFlight = doCheck()
    .catch(() => {}) // no network or the server is down: stay quiet, the next trigger retries
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/**
 * Hook for the API client: the server answered 426. That is the only response
 * the client uses to judge its own version.
 */
export function notifyUpgradeRequired(): void {
  void checkAppStatus('http-426')
}

function isAvailability(value: unknown): value is UpdateAvailability {
  return Object.values(UpdateAvailability).includes(value as UpdateAvailability)
}

function parseAppStatus(body: unknown): AppStatusApiResponse | null {
  const envelope = body as ApiEnvelope<AppStatusApiResponse> | null
  if (!envelope || envelope.status !== true) return null
  const status = envelope.result
  if (!status || typeof status !== 'object') return null
  // The behavior matrix branches on these fields: if the server sent something
  // else, staying quiet and reporting beats reading it as "do not update".
  return isAvailability(status.runtimeUpdate) && isAvailability(status.jsUpdate) ? status : null
}

async function doCheck(): Promise<void> {
  const { versionCode } = await getVersionInfo()
  if (versionCode === null) return
  const params = new URLSearchParams({ platform: currentPlatform(), version_code: String(versionCode) })
  if (otaEnabled()) params.set('js_version', JS_VERSION)
  const res = await fetch(`${getApiBase()}${ApiPath.AppStatus}?${params}`)
  if (!res.ok) {
    // The route is open to any version, so a failure here means the update
    // mechanism has gone blind: no gate, no banner, no OTA, no rollback of a
    // broken bundle.
    reportCheckBroken('http', { status: res.status, versionCode })
    return
  }
  const status = parseAppStatus(await res.json().catch(() => null))
  if (!status) {
    reportCheckBroken('shape', { versionCode })
    return
  }
  lastCheckAt = Date.now()
  await handleStatus(status)
}

/**
 * Staying silent is not an option: the breakage would only surface at the moment the kill switch
 * is needed. It goes to the console, which is visible in the device logs and in debugging.
 */
function reportCheckBroken(reason: 'http' | 'shape', context: Record<string, unknown>): void {
  console.error('app-status check broken', { reason, jsVersion: JS_VERSION, ...context })
}

// ─── behavior matrix ──────────────────────────────────────────────────────────

async function handleStatus(status: AppStatusApiResponse): Promise<void> {
  const links = { storeUrl: status.storeUrl, downloadUrl: status.downloadUrl }

  // The native build below the minimum comes first: fresh JS will not run on it.
  if (status.runtimeUpdate === UpdateAvailability.Required) {
    reportAppUpdate('store', 'forced', status.latestVersionCode)
    emit({ kind: 'store-required', ...links })
    return
  }

  let jsUpdate = status.jsUpdate
  // First launch after a native update: the bundle baked into the build may have
  // gone stale during review, so the background update is made immediate.
  if (jsUpdate === UpdateAvailability.Available && firstRunAfterNativeUpdate) {
    jsUpdate = UpdateAvailability.Required
  }
  firstRunAfterNativeUpdate = false

  switch (jsUpdate) {
    case UpdateAvailability.Required:
      if (!status.jsBundleUrl) break
      if (criticalOps > 0) {
        pendingRequired = status
        emit({ kind: 'pending' })
      } else {
        await applyRequired(status)
      }
      return // the WebView is about to restart, so the banner is pointless
    case UpdateAvailability.Available:
      if (status.jsBundleUrl) void downloadForNextLaunch(status)
      break
    case UpdateAvailability.NotAvailable:
      break
  }

  switch (status.runtimeUpdate) {
    case UpdateAvailability.Available: {
      let dismissed: string | null = null
      try {
        dismissed = localStorage.getItem(BANNER_DISMISSED_KEY)
      } catch {
        // Storage is unavailable, so the banner shows again. That is acceptable.
      }
      if (dismissed !== String(status.latestVersionCode)) {
        reportAppUpdate('store', 'available', status.latestVersionCode)
        emit({ kind: 'store-banner', ...links, versionCode: status.latestVersionCode })
      }
      return
    }
    case UpdateAvailability.NotAvailable:
      emit({ kind: 'none' })
      return
  }
}

/** "Later" on the banner: this version is not offered again. */
export function dismissStoreBanner(versionCode: number): void {
  try {
    localStorage.setItem(BANNER_DISMISSED_KEY, String(versionCode))
  } catch {
    // see handleStatus
  }
  reportAppUpdate('store', 'dismissed', versionCode)
  emit({ kind: 'none' })
}

// ─── downloading and applying bundles ─────────────────────────────────────────

type Updater = typeof import('@capgo/capacitor-updater').CapacitorUpdater

/**
 * The plugin is returned wrapped in an object on purpose.
 *
 * Capacitor turns any property access on a plugin into a native call, so the object also has a
 * `then`. A promise treats that as a thenable and calls it — "CapacitorUpdater.then() is not
 * implemented on android" — and never resolves, which silently broke notifyAppReady, downloads
 * and applying bundles.
 */
async function getUpdater(): Promise<{ plugin: Updater }> {
  return { plugin: (await import('@capgo/capacitor-updater')).CapacitorUpdater }
}

/** An already downloaded bundle of this version, or downloads it (the plugin verifies SHA-256). */
async function getOrDownload(updater: Updater, status: AppStatusApiResponse) {
  const version = status.jsVersion!
  try {
    const { bundles } = await updater.list()
    const existing = bundles.find((bundle) => bundle.version === version)
    if (existing) return existing
  } catch {
    // The list is unavailable, so just download again.
  }
  return updater.download({
    url: status.jsBundleUrl!,
    version,
    ...(status.jsBundleChecksum ? { checksum: status.jsBundleChecksum } : {}),
  })
}

async function applyRequired(status: AppStatusApiResponse): Promise<void> {
  reportAppUpdate('ota', 'forced', status.jsVersion ?? '')
  emit({ kind: 'js-updating' })
  try {
    const { plugin: updater } = await getUpdater()
    const bundle = await getOrDownload(updater, status)
    // set() restarts the WebView and never resolves, so there is no code after it.
    await updater.set({ id: bundle.id })
  } catch {
    // The download failed, so do not lock the person out: the server version gate will not
    // let an outdated client near the API anyway, and the next trigger retries.
    emit({ kind: 'none' })
  }
}

async function downloadForNextLaunch(status: AppStatusApiResponse): Promise<void> {
  try {
    // This version is already downloaded and set as next, so skip it on every launch.
    if (localStorage.getItem(NEXT_BUNDLE_KEY) === status.jsVersion) return
  } catch {
    // see below
  }
  reportAppUpdate('ota', 'available', status.jsVersion ?? '')
  try {
    const { plugin: updater } = await getUpdater()
    const bundle = await getOrDownload(updater, status)
    await updater.next({ id: bundle.id })
    try {
      localStorage.setItem(NEXT_BUNDLE_KEY, status.jsVersion!)
    } catch {
      // Without the marker we only download again on the next launch.
    }
  } catch {
    // It failed, so retry on the next check.
  }
}

// ─── initialization and triggers ──────────────────────────────────────────────

/**
 * Tells the plugin the bundle survived until the UI started, otherwise the
 * watchdog rolls it back to the previous one. A miss here is silent and
 * expensive, and looks like "OTA never arrives", hence the report.
 */
function confirmBundleReady(): void {
  getUpdater()
    .then(({ plugin }) => plugin.notifyAppReady())
    .catch((error: unknown) => {
      console.error('ota notifyAppReady failed', {
        jsVersion: JS_VERSION,
        error: error instanceof Error ? error.message : String(error),
      })
    })
}

/** Marks the first launch after a new native build was installed (see handleStatus). */
async function detectNativeUpdate(): Promise<void> {
  const { versionCode } = await getVersionInfo()
  try {
    if (versionCode !== null) {
      const stored = localStorage.getItem(LAST_VERSION_CODE_KEY)
      firstRunAfterNativeUpdate = stored !== null && stored !== String(versionCode)
      if (firstRunAfterNativeUpdate) reportAppUpdate('store', 'applied', versionCode)
      localStorage.setItem(LAST_VERSION_CODE_KEY, String(versionCode))
    }
    // The next bundle has been applied, so the marker is no longer needed.
    if (localStorage.getItem(NEXT_BUNDLE_KEY) === JS_VERSION) {
      reportAppUpdate('ota', 'applied', JS_VERSION)
      localStorage.removeItem(NEXT_BUNDLE_KEY)
    }
  } catch {
    // Storage is unavailable, so go on without the escalation and the marker.
  }
}

/**
 * Once at startup (F7App): in the APK it confirms the bundle, runs the first
 * check and wires the resume and network triggers; in the web build a service
 * worker replaces all of that.
 */
export function initAppUpdates(): () => void {
  if (isWebBuild()) {
    return initServiceWorker(() => {
      reportAppUpdate('service_worker', 'available')
      emit({ kind: 'web-update' })
    })
  }
  if (!isNative()) return () => {}

  confirmBundleReady()
  void detectNativeUpdate().then(() => checkAppStatus('launch'))

  const cleanups: Array<() => void> = []
  let removed = false
  void App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) void checkAppStatus('resume')
  }).then((handle) => {
    if (removed) void handle.remove()
    else cleanups.push(() => void handle.remove())
  })

  let wasOffline = false
  cleanups.push(
    onNetworkChange((online) => {
      if (!online) {
        wasOffline = true
      } else if (wasOffline) {
        wasOffline = false
        void checkAppStatus('network')
      }
    }),
  )

  return () => {
    removed = true
    cleanups.forEach((fn) => fn())
  }
}
