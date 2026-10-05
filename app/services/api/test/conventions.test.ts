/**
 * Application conventions: the single way routes answer.
 *
 * The client/server boundary check that used to live here ("client does not import server, core
 * or db") no longer needs a text scan: after extracting this server into its own package, the
 * client (apps/mobile) has no dependency on @ryadom/core or @ryadom/db in its package.json at
 * all — the boundary is a fact of the dependency graph, not a convention to police.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function walk(dir: string, visit: (path: string, text: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, visit)
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue
    visit(full, readFileSync(full, 'utf8'))
  }
}

const srcDir = fileURLToPath(new URL('../src', import.meta.url))

describe('ответы роутов', () => {
  it('роуты отвечают только apiOk / apiRefused / apiError', () => {
    const routesDir = join(srcDir, 'routes')
    const offenders: string[] = []
    walk(routesDir, (path, text) => {
      // health returns bare JSON for monitoring, which is the only exception.
      const name = path.slice(routesDir.length + 1)
      if (name.startsWith('health')) return
      if (/c\.json\(/.test(text) || /c\.text\(/.test(text)) offenders.push(name)
    })
    expect(offenders).toEqual([])
  })

  it('каждый роут с правилами объявляет коды в контракте, а не строками по месту', () => {
    const routesDir = join(srcDir, 'routes')
    const offenders: string[] = []
    walk(routesDir, (path, text) => {
      for (const match of text.matchAll(/apiRefused\(\s*c,\s*([^,]+),/g)) {
        const code = match[1]!.trim()
        // The code must come from a contract enum (`XxxApiErrorCode.YYY`), not be a literal.
        if (!/ApiErrorCode\./.test(code)) offenders.push(`${path.slice(routesDir.length + 1)}: ${code}`)
      }
    })
    expect(offenders).toEqual([])
  })
})
