/**
 * Day/night palette choice shared by Web, PWA and Telegram: light from 07:00 to 21:59, dark from
 * 22:00 to 06:59, all in the local time of the device. The OS `prefers-color-scheme` is never
 * read — the product promises the same palette at the same hour on every device. A manual choice
 * from the theme switch is stored on the device and wins over the schedule until the next manual
 * change; there is deliberately no way back to "auto", which keeps the switch predictable.
 */

export type Theme = 'light' | 'dark'

/**
 * The localStorage key of the manual choice. Web and PWA on one origin share the keyspace (see
 * storage.ts), and sharing the theme between them is what a person expects from one device.
 */
export const THEME_STORAGE_KEY = 'ryadom.theme'

const LIGHT_START_HOUR = 7
const DARK_START_HOUR = 22

/** The theme the schedule gives at a moment: light inside [07:00, 22:00) local, dark otherwise. */
export function themeForTime(now: Date): Theme {
  const hour = now.getHours()
  return hour >= LIGHT_START_HOUR && hour < DARK_START_HOUR ? 'light' : 'dark'
}

/**
 * The next moment the schedule flips — what an open client arms its timer on to switch without
 * a reload. Built with local calendar arithmetic, so a DST shift still lands on the wall-clock
 * 07:00 or 22:00 rather than on a fixed offset from now.
 */
export function nextThemeBoundary(now: Date): Date {
  const light = new Date(now.getFullYear(), now.getMonth(), now.getDate(), LIGHT_START_HOUR, 0, 0, 0)
  const dark = new Date(now.getFullYear(), now.getMonth(), now.getDate(), DARK_START_HOUR, 0, 0, 0)
  if (now < light) return light
  if (now < dark) return dark
  return new Date(light.getFullYear(), light.getMonth(), light.getDate() + 1, LIGHT_START_HOUR, 0, 0, 0)
}

/** Milliseconds until `nextThemeBoundary` — the delay for the boundary timer. */
export function msToNextThemeBoundary(now: Date): number {
  return nextThemeBoundary(now).getTime() - now.getTime()
}

/** The effective theme: the manual choice while there is one, the schedule otherwise. */
export function resolveTheme(now: Date, override: Theme | null | undefined): Theme {
  return override ?? themeForTime(now)
}

/**
 * The slice of Web Storage the theme needs. Structural rather than the DOM `Storage`, so the
 * platform adapter and tests can pass their own; `localStorage` satisfies it as is.
 */
export interface ThemeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * The saved manual choice, or null when there is none or it is unreadable. Storage may throw
 * (blocked cookies, private mode) and a foreign or outdated value may not be a theme — both are
 * read as "no choice", which hands the decision back to the schedule.
 */
export function readThemeOverride(storage: ThemeStorage, key: string = THEME_STORAGE_KEY): Theme | null {
  try {
    const value = storage.getItem(key)
    return value === 'light' || value === 'dark' ? value : null
  } catch {
    return null
  }
}

/**
 * Persist the manual choice on this device only; nothing is sent anywhere. A failed write is
 * swallowed: the theme still applies for the session, it just does not survive a restart — the
 * same trade the session storage documents.
 */
export function saveThemeOverride(
  storage: ThemeStorage,
  theme: Theme,
  key: string = THEME_STORAGE_KEY,
): void {
  try {
    storage.setItem(key, theme)
  } catch {
    // Nothing to fall back to: a blocked storage simply keeps the choice session-only.
  }
}
