#!/usr/bin/env node
/**
 * The dev flavour on an emulator or a phone (adb), for development rather than release:
 *
 *   pnpm android:dev   Vite bundle (--mode dev), cap sync, assembleDevDebug, install, launch
 *   pnpm android:live  the same, but the WebView loads the Vite dev server (CAP_LIVE_RELOAD_URL,
 *                      http://10.0.2.2:5174 by default), so edits show up without a rebuild.
 *                      Requires a running `pnpm dev`.
 *
 * Release builds (prod, signing, versionCode) are produced by CI.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv[2]
if (mode !== 'dev' && mode !== 'live') {
  console.error('usage: node scripts/android.mjs dev|live')
  process.exit(2)
}

const isWindows = process.platform === 'win32'

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { stdio: 'inherit', shell: isWindows, cwd: root, ...options })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const env = { ...process.env }
if (mode === 'live') {
  env.CAP_LIVE_RELOAD_URL = process.env.CAP_LIVE_RELOAD_URL ?? 'http://10.0.2.2:5174'
} else {
  // No dev server address, otherwise the APK would carry server.url from the last live run.
  delete env.CAP_LIVE_RELOAD_URL
}

// cap sync copies dist/client into the native project, so it must exist even under live reload.
if (mode === 'dev' || !existsSync(join(root, 'dist', 'client', 'index.html'))) {
  run('pnpm', ['exec', 'vite', 'build', '--mode', 'dev'])
}
run('pnpm', ['exec', 'cap', 'sync', 'android'], { env })
run(join(root, 'android', isWindows ? 'gradlew.bat' : 'gradlew'), ['assembleDevDebug'], { cwd: join(root, 'android') })
run('adb', ['install', '-r', join('android', 'app', 'build', 'outputs', 'apk', 'dev', 'debug', 'app-dev-debug.apk')])
run('adb', ['shell', 'am', 'start', '-n', 'ru.ryadom.app.dev/ru.ryadom.app.MainActivity'])
