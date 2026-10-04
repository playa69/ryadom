#!/usr/bin/env node
// Runs a command under a file mutex in the repository root.
// Needed when several agents change dependencies at once: `node scripts/with-lock.mjs pnpm install`.
// mkdir is atomic, so the .install-lock directory serves as the lock. A stale lock (> 15 min) is dropped.
import { mkdirSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lockDir = join(root, '.install-lock')
const STALE_MS = 15 * 60 * 1000
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const [cmd, ...args] = process.argv.slice(2)
if (!cmd) {
  console.error('usage: node scripts/with-lock.mjs <command> [...args]')
  process.exit(2)
}

for (let waited = 0; ; waited += 2000) {
  try {
    mkdirSync(lockDir)
    break
  } catch {
    try {
      if (Date.now() - statSync(lockDir).mtimeMs > STALE_MS) rmSync(lockDir, { recursive: true, force: true })
    } catch {}
    if (waited % 30000 === 0) console.error(`[with-lock] ожидаю освобождения ${lockDir}...`)
    sleep(2000)
  }
}

try {
  // On Windows pnpm/npm are .cmd shims, so they run through the shell as a single string.
  const result =
    process.platform === 'win32'
      ? spawnSync([cmd, ...args].join(' '), { stdio: 'inherit', cwd: root, shell: true })
      : spawnSync(cmd, args, { stdio: 'inherit', cwd: root })
  process.exitCode = result.status ?? 1
} finally {
  rmSync(lockDir, { recursive: true, force: true })
}
