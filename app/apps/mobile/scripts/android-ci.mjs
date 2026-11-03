#!/usr/bin/env node
/**
 * Starts an Android build in Codemagic (codemagic.yaml at the repository root), waits for it and
 * downloads the artifacts into android/ci-artifacts/<build id>/ (git-ignored):
 *
 *   pnpm android:ci debug [--branch <name>]
 *   pnpm android:ci release --version-code <n> [--branch <name>]
 *
 * Codemagic clones the branch from GitHub, so it has to be pushed; a release refuses to start when
 * the local checkout differs from GitHub. Signing keys and the API token are read from Lockbox with
 * the yc CLI (YC_PROFILE picks a profile) and travel in the request body for this one build only:
 * Codemagic keeps no copy. Runbook: android/README.md.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ID = '6aea2d6ffa6ad410c45e38f2'
const WORKFLOWS = { debug: 'android-debug', release: 'android-release' }
// Lockbox secrets by id, so the profile's default folder does not matter.
const APP_SECRETS_ID = 'e6qlbsdv554cav7urkn2' // ryadom-app-secrets
const ACCESS_SECRETS_ID = 'e6q41s4369rfldovjc1k' // ryadom-cluster-access
const KEYS = {
  debug: ['ANDROID_DEBUG_KEYSTORE'],
  release: ['ANDROID_RELEASE_KEYSTORE', 'ANDROID_RELEASE_KEYSTORE_PASSWORD', 'ANDROID_RELEASE_KEY_ALIAS'],
}
const DONE = new Set(['finished', 'warning'])
const FAILED = new Set(['failed', 'canceled', 'timeout', 'skipped'])

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  console.error(message)
  process.exit(1)
}

function parseArgs(argv) {
  const [kind, ...rest] = argv
  if (!WORKFLOWS[kind]) fail('usage: pnpm android:ci debug|release [--branch <name>] [--version-code <n>]')
  const opts = { kind }
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] === '--branch') opts.branch = rest[i + 1]
    else if (rest[i] === '--version-code') opts.versionCode = rest[i + 1]
    else fail(`unknown option ${rest[i]}`)
  }
  if (kind === 'release' && !/^[1-9]\d*$/.test(opts.versionCode ?? '')) {
    fail('release needs --version-code <n>, strictly greater than the last published one')
  }
  return opts
}

function git(...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : ''
}

function lockbox(secretId) {
  const args = ['lockbox', 'payload', 'get', '--id', secretId, '--format', 'json']
  if (process.env.YC_PROFILE) args.unshift('--profile', process.env.YC_PROFILE)
  const r = spawnSync('yc', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (r.error || r.status !== 0)
    fail(`yc failed: ${r.error?.message ?? r.stderr.trim()} (check Lockbox access)`)
  return Object.fromEntries(JSON.parse(r.stdout).entries.map((e) => [e.key, e.text_value]))
}

const opts = parseArgs(process.argv.slice(2))
const current = git('rev-parse', '--abbrev-ref', 'HEAD')
const branch = opts.branch || current
if (!branch || branch === 'HEAD') fail('pass --branch: the current checkout is not on a branch')

// Codemagic builds what is on GitHub, not this checkout: say so when they differ.
const remoteSha = git('ls-remote', 'origin', `refs/heads/${branch}`).split(/\s+/)[0]
if (!remoteSha) fail(`branch ${branch} is not on GitHub: push it first`)
if (branch === current) {
  const problems = []
  if (git('status', '--porcelain')) problems.push('uncommitted changes')
  if (git('rev-parse', 'HEAD') !== remoteSha) problems.push('local HEAD differs from GitHub')
  if (problems.length) {
    const message = `${problems.join(', ')}: Codemagic will build ${remoteSha.slice(0, 7)} from GitHub`
    if (opts.kind === 'release') fail(`${message}. Release refused.`)
    console.warn(`warning: ${message}`)
  }
}

const token = lockbox(ACCESS_SECRETS_ID)['codemagic-api-token']
if (!token) fail('Lockbox entry codemagic-api-token is missing')
const secrets = lockbox(APP_SECRETS_ID)
const variables = { EXPECTED_SHA: remoteSha }
for (const key of KEYS[opts.kind]) {
  if (!secrets[key]) fail(`Lockbox entry ${key} is missing`)
  variables[key] = secrets[key]
}
if (opts.versionCode) variables.RYADOM_VERSION_CODE = opts.versionCode

async function api(method, path, body) {
  const res = await fetch(`https://api.codemagic.io${path}`, {
    method,
    headers: { 'x-auth-token': token, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) fail(`${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`)
  return res.json()
}

const { buildId } = await api('POST', '/builds', {
  appId: APP_ID,
  workflowId: WORKFLOWS[opts.kind],
  branch,
  environment: { variables },
})
console.log(`Build ${buildId}: ${WORKFLOWS[opts.kind]} on ${branch} at ${remoteSha.slice(0, 7)}`)
console.log(`https://codemagic.io/app/${APP_ID}/build/${buildId}`)

let build
let lastStatus = ''
for (;;) {
  const body = await api('GET', `/builds/${buildId}`)
  build = body.build ?? body
  if (build.status !== lastStatus) console.log(`status: ${build.status}`)
  lastStatus = build.status
  if (DONE.has(build.status)) break
  if (FAILED.has(build.status))
    fail(`Build ${buildId} ended with ${build.status}; logs are on the build page`)
  await new Promise((resolve) => setTimeout(resolve, 20_000))
}

const outDir = join(root, 'android', 'ci-artifacts', buildId)
mkdirSync(outDir, { recursive: true })
for (const artefact of build.artefacts ?? []) {
  const res = await fetch(artefact.url, { headers: { 'x-auth-token': token } })
  if (!res.ok) fail(`download ${artefact.name}: ${res.status}`)
  const file = join(outDir, artefact.name)
  writeFileSync(file, Buffer.from(await res.arrayBuffer()))
  console.log(`artifact: ${file}`)
}
