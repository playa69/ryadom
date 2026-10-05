/**
 * The contract ships in every client bundle (apps/mobile, apps/web), so it must carry no runtime
 * dependency of its own — only types, enums and constants. `only import type` is the rule that
 * makes that checkable mechanically instead of by review.
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

describe('границы', () => {
  it('контракт не содержит рантайм-импортов: он едет в бандл каждого клиента', () => {
    const offenders: string[] = []
    walk(srcDir, (path, text) => {
      // Only `import type` is allowed; anything else is a runtime dependency inside the contract.
      const runtimeImports = [...text.matchAll(/^import (?!type )/gm)]
      if (runtimeImports.length > 0) offenders.push(path.slice(srcDir.length + 1))
    })
    expect(offenders).toEqual([])
  })
})
