/**
 * Server-side runtime config. Both addresses are read per request, never at build time, so one
 * image serves staging and prod.
 */

/** The API the browser talks to (REST and WebSocket). No trailing slash. */
export function readApiBase(): string {
  const raw = process.env.PUBLIC_API_URL?.trim() || 'http://localhost:3002'
  return raw.replace(/\/+$/, '')
}

/** The marketing site: the terms and privacy documents live there. No trailing slash. */
export function readWebUrl(): string {
  const raw = process.env.PUBLIC_WEB_URL?.trim() || 'http://localhost:3000'
  return raw.replace(/\/+$/, '')
}

export function toWsBase(apiBase: string): string {
  return apiBase.replace(/^http/, 'ws')
}
