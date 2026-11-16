// openspec/changes/add-fast-dialog-start, «Русскоязычный интерфейс и оформление»: the pre-paint
// boot script restates the schedule of client-core/theme (it runs before the bundle and cannot
// import it). These tests hold the two in step: light inside [07:00, 22:00) local, dark otherwise,
// a stored manual choice wins, and the system palette is never consulted.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { THEME_STORAGE_KEY, themeForTime } from '@ryadom/client-core/theme'
import { THEME_BOOT } from './theme-boot'

interface BootResult {
  dataTheme: string | null
  darkClass: boolean
  colorScheme: string | undefined
  themeColor: string | null
  metaColorScheme: string | null
}

/** Runs the boot source against a stub document, as a browser would before the first paint. */
function runBoot(stored: string | null, hour: number): BootResult {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 0, 15, hour, 0, 0))
  const attrs = new Map<string, string>()
  const classes = new Map<string, boolean>()
  const style: Record<string, string> = {}
  const metas = new Map<string, Map<string, string>>()
  for (const name of ['theme-color', 'color-scheme']) metas.set(name, new Map())
  vi.stubGlobal('window', { localStorage: { getItem: () => stored } })
  vi.stubGlobal('document', {
    documentElement: {
      setAttribute: (name: string, value: string) => void attrs.set(name, value),
      removeAttribute: (name: string) => void attrs.delete(name),
      classList: { toggle: (name: string, on: boolean) => void classes.set(name, on) },
      style,
    },
    querySelector: (selector: string) => {
      const name = /meta\[name="([^"]+)"\]/.exec(selector)?.[1]
      const meta = name ? metas.get(name) : undefined
      return meta ? { setAttribute: (k: string, v: string) => void meta.set(k, v) } : null
    },
  })
  // The palette is render-blocking CSS: by the time the script runs, the token is readable.
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) => (name === '--ryadom-paper' ? ' #00051a ' : ''),
  }))
  new Function(THEME_BOOT)()
  return {
    dataTheme: attrs.get('data-theme') ?? null,
    darkClass: classes.get('dark') === true,
    colorScheme: style.colorScheme,
    themeColor: metas.get('theme-color')?.get('content') ?? null,
    metaColorScheme: metas.get('color-scheme')?.get('content') ?? null,
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('THEME_BOOT', () => {
  it.each([6, 7, 12, 21, 22, 23])('matches themeForTime at %i:00 without a manual choice', (hour) => {
    const result = runBoot(null, hour)
    const expected = themeForTime(new Date(2026, 0, 15, hour, 0, 0))
    expect(result.dataTheme).toBe(expected === 'light' ? 'light' : null)
    expect(result.darkClass).toBe(expected === 'dark')
    expect(result.colorScheme).toBe(expected)
    expect(result.themeColor).toBe('#00051a')
    expect(result.metaColorScheme).toBe(expected)
  })

  it('a stored manual choice wins over the schedule, in both directions', () => {
    expect(runBoot('dark', 12).darkClass).toBe(true)
    expect(runBoot('light', 23).dataTheme).toBe('light')
  })

  it('a foreign value in storage hands the decision back to the schedule', () => {
    expect(runBoot('blue', 12).dataTheme).toBe('light')
  })

  it('reads the same storage key client-core writes', () => {
    expect(THEME_BOOT).toContain(JSON.stringify(THEME_STORAGE_KEY))
  })
})
