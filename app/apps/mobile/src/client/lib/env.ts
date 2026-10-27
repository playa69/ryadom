import { PwaMeta } from '@ryadom/contracts/pwa'

/**
 * Where the app points: the API and the website (legal documents, the download link).
 *
 * Two builds rather than two environments:
 * - prod always points at prod, and the switcher code is physically absent from its bundle;
 * - dev points at local by default and can switch to prod (seven taps on the logo on the sign-in
 *   screen, or on the version in the profile).
 *
 * All switcher code lives in env-switcher.ts and is imported only under the
 * `import.meta.env.VITE_FLAVOR === 'dev'` check, spelled out as a literal in place: in a prod build
 * Vite substitutes `"prod" === "dev"`, and the minifier drops the branch together with the module,
 * and with it the local URLs.
 */

export type EnvId = 'local' | 'prod'

export interface Endpoints {
  /** No trailing slash. An empty string means the same origin (web build, Vite dev server). */
  apiBase: string
  webUrl: string
}

/** How many taps open the environment picker in a dev build. */
export const ENV_SWITCHER_TAPS = 7

export function trimSlash(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

export function prodEndpoints(): Endpoints {
  return {
    apiBase: trimSlash(import.meta.env.VITE_PROD_API_URL ?? ''),
    webUrl: trimSlash(import.meta.env.VITE_PROD_WEB_URL ?? ''),
  }
}

/**
 * Web build: the API is the same origin (the gateway routes `/api` of the host to it), and the
 * website URL arrives in a meta tag that the PWA image inserts into index.html when its container
 * starts.
 */
export function webEndpoints(): Endpoints {
  const meta = document.querySelector(`meta[name="${PwaMeta.WebUrl}"]`)
  return { apiBase: '', webUrl: trimSlash(meta?.getAttribute('content') ?? '') }
}

let current: { id: EnvId; endpoints: Endpoints } =
  import.meta.env.MODE === 'web'
    ? { id: 'prod', endpoints: webEndpoints() }
    : { id: 'prod', endpoints: prodEndpoints() }

/** Sets the environment. Called only by loadEnv and the switcher code. */
export function applyEnv(id: EnvId, endpoints: Endpoints): void {
  current = { id, endpoints: { apiBase: trimSlash(endpoints.apiBase), webUrl: trimSlash(endpoints.webUrl) } }
}

/** Loads the selected environment before the first API request. A no-op in a prod build. */
export async function loadEnv(): Promise<void> {
  if (import.meta.env.VITE_FLAVOR === 'dev') {
    try {
      const { restoreEnv } = await import('./env-switcher')
      await restoreEnv()
    } catch (error) {
      // The switcher is a development tool, so a failure in it must not block startup.
      console.error('Не удалось восстановить среду', error)
    }
  }
}

export function getEnvId(): EnvId {
  return current.id
}

export function getApiBase(): string {
  return current.endpoints.apiBase
}

export function getWebUrl(): string {
  return current.endpoints.webUrl
}

/** WebSocket URL for the dialog: the same host as the API. */
export function getWsBase(): string {
  const base = getApiBase()
  if (base) return base.replace(/^http/, 'ws')
  return `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`
}

/**
 * The environment the server served the page from, web build only: one image serves both the local
 * stack and prod, so there is no other way to tell them apart.
 */
export function getServerAppEnv(): EnvId | null {
  const value = document.querySelector(`meta[name="${PwaMeta.AppEnv}"]`)?.getAttribute('content')
  return value === 'local' || value === 'prod' ? value : null
}
