#!/usr/bin/env node
/**
 * Builds the OTA bundle of the prod native flavour and bakes it into the image. Only prod is served
 * over the air (`services/api/src/lib/ota-bundle.ts`); the dev flavour is for developers' own builds.
 * services/api's Dockerfile runs this once and copies dist/ota/ into the runtime layer. (The PWA is
 * a separate image, apps/mobile/Dockerfile, and has nothing to do with this.) There is no bucket and
 * no separate publish step: the JS bundle ships from the same commit, in the same deploy, as the
 * server that reads its manifest.
 *
 * Requires the `zip` binary (apk add zip in services/api's Dockerfile build stage; already present on
 * GitHub's ubuntu runners). It keeps forward slashes in the archive, which the update plugin
 * requires and which PowerShell's Compress-Archive does not produce.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const clientDist = join(root, 'dist', 'client')
const otaDist = join(root, 'dist', 'ota')
const FLAVOR = 'prod'

if (!existsSync(join(root, 'package.json'))) {
  console.error('apps/mobile/package.json not found next to this script')
  process.exit(1)
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
// Ties the bundle version to the pipeline run that produced this image, the same way
// mobile-android.yml derives the native versionCode from github.run_number. 0 locally, where this
// script is never part of a real release.
const buildNumber = process.env.OTA_BUILD_NUMBER || '0'
const version = `${pkg.version}.${buildNumber}`

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

async function buildFlavor(flavor) {
  await rm(clientDist, { recursive: true, force: true })
  // The flavour is also the build mode, so it is passed on instead of being read from .env.prod:
  // that file is gitignored, and in a clean checkout or in the Docker build the config would fail
  // with "VITE_FLAVOR must be dev or prod". Where the file exists the value is the same.
  run('pnpm', ['exec', 'vite', 'build', '--mode', flavor], {
    cwd: root,
    env: { ...process.env, VITE_FLAVOR: flavor },
  })

  const file = `ryadom-${flavor}-${version}.zip`
  const archivePath = join(otaDist, file)
  await rm(archivePath, { force: true })
  // Run from inside dist/client so index.html lands at the archive's root, not under a subfolder.
  run('zip', ['-qr', archivePath, '.'], { cwd: clientDist })

  const checksum = createHash('sha256')
    .update(await readFile(archivePath))
    .digest('hex')
  return { version, file, checksum }
}

await rm(otaDist, { recursive: true, force: true })
await mkdir(otaDist, { recursive: true })

const manifest = { [FLAVOR]: await buildFlavor(FLAVOR) }

await writeFile(join(otaDist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`\nOTA manifest:\n${JSON.stringify(manifest, null, 2)}`)
