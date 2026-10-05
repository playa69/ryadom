#!/usr/bin/env node
/**
 * Brings up the stack for e2e and holds it until Playwright is done.
 *
 * Its own compose project and its own ports: a test run must not break the database used for
 * development (`pnpm infra:up` on 55433). The ports here are 55434 / 8080+ / 3100 / 3102 / 3103.
 *
 * Built servers rather than `dev`: what has to be checked is what ships in the image.
 */
import { spawn, spawnSync } from 'node:child_process'
import { cp } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const e2eRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(e2eRoot, '..')
const isWindows = process.platform === 'win32'

const DB_URL = 'postgres://ryadom:ryadom@127.0.0.1:55434/ryadom'
const AGENT_URL = 'http://127.0.0.1:8081'
// 3100 is the landing site (its env var is still called WEB_*: the legal pages live there), 3102
// is the API and 3103 is the signed-in web app.
const WEB_PORT = '3100'
const APP_PORT = '3102'
const WEBAPP_PORT = '3103'

const children = []
let shuttingDown = false

function log(message) {
  process.stdout.write(`[stack] ${message}\n`)
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: isWindows,
    cwd: repoRoot,
    ...options,
  })
  if (result.status !== 0) {
    log(`команда упала: ${command} ${args.join(' ')}`)
    shutdown(result.status ?? 1)
  }
}

function start(name, command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: isWindows,
    cwd: repoRoot,
    ...options,
  })
  children.push({ name, child })
  const prefix = (stream) => (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim()) stream.write(`[${name}] ${line}\n`)
    }
  }
  child.stdout.on('data', prefix(process.stdout))
  child.stderr.on('data', prefix(process.stderr))
  child.on('exit', (code) => {
    if (!shuttingDown) {
      log(`${name} завершился с кодом ${code}`)
      shutdown(code ?? 1)
    }
  })
  return child
}

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  for (const { child } of children) child.kill()
  // Always tear the containers down, including on failure: they hold a tmpfs database, and the
  // next run must start from an empty one.
  spawnSync('node', ['scripts/docker.mjs', 'compose', '-f', 'e2e/compose.yaml', 'down', '-v'], {
    stdio: 'inherit',
    shell: isWindows,
    cwd: repoRoot,
  })
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

async function waitFor(url, what, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) {
      log(`${what} не ответил за ${Math.round(timeoutMs / 1000)} с: ${url}`)
      shutdown(1)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

log('поднимаю Postgres, Mailpit и заглушку агента')
// --build: without it compose reuses a cached image, and a changed agent mock silently would
// not reach the tests.
runSync('node', ['scripts/docker.mjs', 'compose', '-f', 'e2e/compose.yaml', 'up', '-d', '--wait', '--build'])

log('применяю миграции')
runSync('pnpm', ['--filter', '@ryadom/db', 'migrate'], { env: { ...process.env, DATABASE_URL: DB_URL } })

log('собираю клиент, api, сайт и веб-приложение')
// apps/mobile's "build" is build:pwa only (it has no server of its own any more).
runSync('pnpm', ['--filter', '@ryadom/mobile', 'build'])
runSync('pnpm', ['--filter', '@ryadom/api', 'build'])
runSync('pnpm', ['--filter', '@ryadom/landing', 'build'])
runSync('pnpm', ['--filter', '@ryadom/web', 'build'])

// api serves the PWA apps/mobile just built (lib/pwa.ts resolves ./pwa next to cwd, then
// ./dist/pwa) — outside Docker the two live in sibling packages, so it has to be copied over,
// the same way the Dockerfile's runtime stage copies it next to the server bundle.
await cp(join(repoRoot, 'apps', 'mobile', 'dist', 'pwa'), join(repoRoot, 'services', 'api', 'dist', 'pwa'), {
  recursive: true,
})

const apiEnv = {
  ...process.env,
  NODE_ENV: 'production',
  APP_ENV: 'local',
  LOG_LEVEL: 'warn',
  PORT: APP_PORT,
  DATABASE_URL: DB_URL,
  AUTH_SECRET: 'e2e-only-auth-secret-0123456789abcdef',
  MOBILE_JWT_SECRET: 'e2e-only-mobile-secret-0123456789abcdef',
  PUBLIC_WEB_URL: `http://127.0.0.1:${WEB_PORT}`,
  PUBLIC_APP_URL: `http://127.0.0.1:${APP_PORT}`,
  EMAIL_TRANSPORT: 'smtp',
  EMAIL_FROM: 'Рядом <noreply@ryadom.local>',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1027',
  AGENT_API_URL: AGENT_URL,
  AGENT_TIMEOUT_MS: '10000',
  DIALOG_IDLE_TIMEOUT_SEC: '900',
  DIALOG_MAX_DURATION_SEC: '7200',
}

log('запускаю api')
// cwd is services/api: from there the server finds the copied PWA (dist/pwa) and the native argon2.
start('api', 'node', ['dist/index.js'], { env: apiEnv, cwd: join(repoRoot, 'services', 'api') })
await waitFor(`http://127.0.0.1:${APP_PORT}/api/health`, 'api')

// A Next standalone build contains neither the static assets nor public: the Dockerfile copies
// them in next to it. We do the same, otherwise the tests would check the site without styles
// and never notice.
const webStandalone = join(repoRoot, 'apps', 'web', '.next', 'standalone', 'apps', 'web')
await cp(join(repoRoot, 'apps', 'web', '.next', 'static'), join(webStandalone, '.next', 'static'), {
  recursive: true,
})
await cp(join(repoRoot, 'apps', 'web', 'public'), join(webStandalone, 'public'), { recursive: true })

log('запускаю веб-приложение')
// Its two addresses are runtime config, like in the image: the browser talks to the API directly
// (the CSP connect-src is built from PUBLIC_API_URL), and the legal links point at the landing.
start('web', 'node', ['server.js'], {
  cwd: webStandalone,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT: WEBAPP_PORT,
    HOSTNAME: '127.0.0.1',
    PUBLIC_API_URL: `http://127.0.0.1:${APP_PORT}`,
    PUBLIC_WEB_URL: `http://127.0.0.1:${WEB_PORT}`,
  },
})
await waitFor(`http://127.0.0.1:${WEBAPP_PORT}/api/health`, 'веб-приложение')

const landingStandalone = join(repoRoot, 'apps', 'landing', '.next', 'standalone', 'apps', 'landing')
await cp(join(repoRoot, 'apps', 'landing', '.next', 'static'), join(landingStandalone, '.next', 'static'), {
  recursive: true,
})
await cp(join(repoRoot, 'apps', 'landing', 'public'), join(landingStandalone, 'public'), { recursive: true })

// The landing starts last: Playwright's webServer polls it, so once it answers everything is up.
log('запускаю сайт')
start('landing', 'node', ['server.js'], {
  cwd: landingStandalone,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT: WEB_PORT,
    HOSTNAME: '127.0.0.1',
    PUBLIC_APP_URL: `http://127.0.0.1:${APP_PORT}`,
    PUBLIC_SUPPORT_EMAIL: 'support@ryadom.local',
  },
})
await waitFor(`http://127.0.0.1:${WEB_PORT}/api/health`, 'сайт')

log('стек готов')
