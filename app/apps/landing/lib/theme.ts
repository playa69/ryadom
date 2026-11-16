'use client'

import {
  msToNextThemeBoundary,
  readThemeOverride,
  resolveTheme,
  saveThemeOverride,
  type Theme,
} from '@ryadom/client-core/theme'
import { useSyncExternalStore } from 'react'

/**
 * The theme glue of the site. The palette itself is CSS: dark in `:root`, light through the
 * `data-theme="light"` attribute in the design tokens. This module applies the resolved theme to
 * the document, persists the manual choice on this device (through client-core, nothing is sent
 * anywhere) and lets React follow the current value. The system `prefers-color-scheme` is never
 * read: the schedule and the manual choice are the only inputs.
 */

/** Storage access can throw (blocked cookies, private mode): an unreadable choice is "no choice". */
function overrideChoice(): Theme | null {
  try {
    return readThemeOverride(window.localStorage)
  } catch {
    return null
  }
}

/** The effective theme right now: the manual choice while there is one, the schedule otherwise. */
export function scheduledTheme(now = new Date()): Theme {
  return resolveTheme(now, overrideChoice())
}

const listeners = new Set<() => void>()

/**
 * Paints the theme onto the document: the `data-theme` attribute the tokens key on, the `dark`
 * class the `dark:` variant keys on, the color scheme and the browser chrome color. The chrome
 * color is read from the palette itself, so it follows whatever the tokens set, light or dark.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'light') root.setAttribute('data-theme', 'light')
  else root.removeAttribute('data-theme')
  root.classList.toggle('dark', theme === 'dark')
  root.style.colorScheme = theme
  const paper = getComputedStyle(root).getPropertyValue('--ryadom-paper').trim()
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (meta && paper) meta.content = paper
  const scheme = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')
  if (scheme) scheme.content = theme
  for (const listener of listeners) listener()
}

/** The manual choice: stored on this device, applied at once, and it wins over the schedule. */
export function chooseTheme(theme: Theme): void {
  try {
    saveThemeOverride(window.localStorage, theme)
  } catch {
    // A blocked storage keeps the choice session-only; the theme still applies.
  }
  applyTheme(theme)
}

/** The theme the document currently wears; the boot script and `applyTheme` both mark it. */
function currentTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The current theme for a component; updates on the switch and on a schedule boundary. */
export function useTheme(): Theme {
  // The server markup always starts dark (the CSS default), the boot script flips it pre-hydration.
  return useSyncExternalStore(subscribe, currentTheme, () => 'dark')
}

/**
 * Milliseconds until the next 07:00/22:00 flip of the schedule — the delay the open client arms
 * its timer on. Re-exported so the runtime component has a single import site here.
 */
export function themeBoundaryDelay(now = new Date()): number {
  return msToNextThemeBoundary(now)
}

export type { Theme }
