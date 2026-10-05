#!/usr/bin/env node
/**
 * Compares two folders of screenshots with the same file names and reports how much of each picture
 * changed. A refactor that is meant to leave the look alone should come out near 0%; anything a
 * human would notice (a shifted block, a missing glow, another size) shows up as several percent.
 *
 * Usage: take a set into a scratch folder with ui-shots.mjs --out <dir> before and after a change, then
 *   node e2e/scripts/ui-diff.mjs --a <dir-before> --b <dir-after> \
 *            [--only web-home,web-profile] [--out <dir-for-diffs>] [--limit 1.5]
 *
 * Writes <name>-diff.png (changed pixels in red over a faded copy of A) into --out when a pair
 * differs by more than --limit percent (default 0.5). Exit code 1 when any pair exceeds the limit
 * or has a different size.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, all) => {
    if (!arg.startsWith('--')) return acc
    const next = all[i + 1]
    acc.push([arg.slice(2), next && !next.startsWith('--') ? next : true])
    return acc
  }, []),
)

if (!args.a || !args.b) {
  console.error('usage: --a <dir> --b <dir> [--only prefix1,prefix2] [--out dir] [--limit percent]')
  process.exit(2)
}

const dirA = resolve(String(args.a))
const dirB = resolve(String(args.b))
const out = resolve(String(args.out ?? join(dirB, '..', 'diff')))
const limit = Number(args.limit ?? 0.5)
const only = args.only ? String(args.only).split(',') : null

const namesB = new Set((await readdir(dirB)).filter((name) => name.endsWith('.png')))
const names = (await readdir(dirA))
  .filter((name) => name.endsWith('.png') && namesB.has(name))
  .filter((name) => !only || only.some((prefix) => name.startsWith(prefix)))
  .sort()

await mkdir(out, { recursive: true })
let bad = 0
const rows = []

for (const name of names) {
  const a = PNG.sync.read(await readFile(join(dirA, name)))
  const b = PNG.sync.read(await readFile(join(dirB, name)))
  if (a.width !== b.width || a.height !== b.height) {
    rows.push(`${name.padEnd(48)} SIZE ${a.width}x${a.height} -> ${b.width}x${b.height}`)
    bad++
    continue
  }
  const diff = new PNG({ width: a.width, height: a.height })
  const changed = pixelmatch(a.data, b.data, diff.data, a.width, a.height, {
    threshold: 0.12,
    includeAA: false,
    alpha: 0.25,
    diffColor: [255, 40, 80],
  })
  const percent = (changed / (a.width * a.height)) * 100
  const flag = percent > limit ? '  <-- check' : ''
  if (percent > limit) {
    await writeFile(join(out, name.replace(/\.png$/, '-diff.png')), PNG.sync.write(diff))
    bad++
  }
  rows.push(`${name.padEnd(48)} ${percent.toFixed(2).padStart(6)}%${flag}`)
}

console.log(rows.join('\n'))
console.log(`\n${names.length} compared, ${bad} over ${limit}% or resized; diffs in ${out}`)
process.exit(bad ? 1 : 0)
