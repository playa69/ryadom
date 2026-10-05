/**
 * proxy.ts sets the CSP (with the nonce) on every page. Under a basePath (`/app`) Next puts the
 * prefix in front of each matcher source, so the catch-all pattern becomes `/app/((?!…).*)`, which
 * does not match `/app` itself. The home page then goes out with no CSP at all, in an app that keeps
 * the refresh token in localStorage and relies on the CSP to protect it. The bare `/` source is the
 * one Next maps to the prefix alone, so it has to stay in the list.
 */
import { describe, expect, it } from 'vitest'
import { config } from '../proxy'

type Source = { source: string; missing?: unknown[] }
const sources = (config.matcher as Source[]).map((entry) => entry.source)

describe('matcher proxy.ts', () => {
  it('отдельно покрывает корневую страницу (иначе под basePath она остаётся без CSP)', () => {
    expect(sources).toContain('/')
  })

  it('остальные страницы покрыты, а проба здоровья и статика исключены', () => {
    const catchAll = sources.find((source) => source !== '/')
    expect(catchAll).toBeDefined()
    for (const excluded of ['api/health', '_next/static', '_next/image', 'favicon.svg', 'voice-worklet.js']) {
      expect(catchAll).toContain(excluded)
    }
  })

  it('оба источника пропускают prefetch-запросы одинаково', () => {
    const entries = config.matcher as Source[]
    expect(entries.length).toBeGreaterThanOrEqual(2)
    const [first, ...rest] = entries.map((entry) => JSON.stringify(entry.missing))
    for (const other of rest) expect(other).toBe(first)
  })
})
