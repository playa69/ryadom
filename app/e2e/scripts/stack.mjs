#!/usr/bin/env node
/**
 * Brings up the stack for e2e and holds it until Playwright is done.
 *
 * Its own compose project and its own ports: a test run must not break the database used for
 * development (`pnpm infra:up` on 55433). The ports here are 55434 / 8080+ / 3100 / 3102 / 3103 / 3104.
 * E2E_PORT_OFFSET shifts all of them (playwright.config.ts computes the same addresses) and gives the
 * compose project its own name, so several runs on one machine, e.g. parallel agents, each get a stack of
 * their own instead of queueing for these ports or reusing a stranger's.
 *
 * The apps are built through Turborepo with its cache: an app whose sources (and those of the packages it
 * uses) did not change since a previous build comes back in seconds. TURBO_CACHE_DIR can point several
 * checkouts at one cache.
 *
 * Built servers rather than `dev`: what has to be checked is what ships in the image. The one
 * exception is the PWA: in production it is an nginx image (apps/mobile/Dockerfile), here the same
 * build is served by `vite preview`, which also proxies `/api` to the API so the client stays on one
 * origin, as it is behind the gateway. The nginx behaviour (headers, cache, fallback) is checked on
 * the image itself, not here.
 */
import { spawn, spawnSync } from 'node:child_process'
import { cp } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const e2eRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(e2eRoot, '..')
const isWindows = process.platform === 'win32'

const OFFSET = Number(process.env.E2E_PORT_OFFSET ?? 0)
const port = (base) => String(base + OFFSET)
const DB_PORT = port(55434)
const SMTP_PORT = port(1027)
const DB_URL = `postgres://ryadom:ryadom@127.0.0.1:${DB_PORT}/ryadom`
const AGENT_URL = `http://127.0.0.1:${port(8081)}`
// 3100 is the landing site (its env var is still called WEB_*: the legal pages live there), 3102
// is the API, 3103 is the signed-in web app and 3104 is the PWA.
const WEB_PORT = port(3100)
const APP_PORT = port(3102)
const WEBAPP_PORT = port(3103)
const PWA_PORT = port(3104)

// The project follows the caller's (an agent run sets COMPOSE_PROJECT_NAME) or the offset, so that two stacks
// never share containers. compose.yaml reads the ports from these variables; through WSL only the names
// listed in WSLENV get across.
const PROJECT = process.env.COMPOSE_PROJECT_NAME
  ? `${process.env.COMPOSE_PROJECT_NAME}-e2e`
  : OFFSET ? `ryadom-e2e-${OFFSET}` : 'ryadom-e2e'
const COMPOSE_PORTS = { E2E_DB_PORT: DB_PORT, E2E_SMTP_PORT: SMTP_PORT, E2E_MAIL_PORT: port(8027), E2E_AGENT_PORT: port(8081) }
const composeEnv = {
  ...process.env,
  ...COMPOSE_PORTS,
  WSLENV: [process.env.WSLENV, ...Object.keys(COMPOSE_PORTS)].filter(Boolean).join(':'),
}
const compose = (...args) => ['scripts/docker.mjs', 'compose', '-p', PROJECT, '-f', 'e2e/compose.yaml', ...args]

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
  spawnSync('node', compose('down', '-v'), {
    stdio: 'inherit',
    shell: isWindows,
    cwd: repoRoot,
    env: composeEnv,
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
runSync('node', compose('up', '-d', '--wait', '--build'), { env: composeEnv })

log('применяю миграции')
runSync('pnpm', ['--filter', '@ryadom/db', 'migrate'], { env: { ...process.env, DATABASE_URL: DB_URL } })

/** The build-time switches of the tests in the web app and the PWA: both on by default, both off with `E2E_SELF_CHECK=0`. */
function selfCheckBuildEnv() {
  const on = process.env.E2E_SELF_CHECK === '0' ? '0' : '1'
  return {
    NEXT_PUBLIC_SELF_CHECK_ENABLED: on,
    NEXT_PUBLIC_SELF_CHECK_PREVIEW: on,
    VITE_SELF_CHECK_ENABLED: on,
    VITE_SELF_CHECK_PREVIEW: on,
  }
}

log('собираю клиент, api, сайт и веб-приложение')
// apps/mobile's "build" is build:pwa: the web build into dist/pwa, which `vite preview` serves below.
// Two at a time: four Next.js and Vite builds at once would need several gigabytes of memory.
runSync('pnpm', [
  'exec', 'turbo', 'run', 'build', '--concurrency=2', '--output-logs=new-only',
  '--filter=@ryadom/mobile', '--filter=@ryadom/api', '--filter=@ryadom/landing', '--filter=@ryadom/web',
], {
  // Tests inside the app (add-self-check-tests, D9) are on in the e2e stack, with the texts that still wait for
  // sign-off (status `review`); `E2E_SELF_CHECK=0` builds the stack as production has it before the switch.
  env: { ...process.env, ...selfCheckBuildEnv() },
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
  PUBLIC_WEBAPP_URL: `http://127.0.0.1:${WEBAPP_PORT}`,
  EMAIL_TRANSPORT: 'smtp',
  EMAIL_FROM: 'Рядом <noreply@ryadom.local>',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT,
  AGENT_API_URL: AGENT_URL,
  AGENT_TIMEOUT_MS: '10000',
  DIALOG_IDLE_TIMEOUT_SEC: '900',
  DIALOG_MAX_DURATION_SEC: '7200',
  // An open dialog whose session was ended closes within this long: the scenario waits for it.
  DIALOG_SESSION_CHECK_SEC: '2',
  // As in production: Chromium decodes Opus with WebCodecs, so the voice scenarios play Opus speech.
  DIALOG_AUDIO_CODECS: 'opus,mulaw',
  // A made-up bot: support/telegram.ts signs the Mini App launches with the same value.
  TELEGRAM_BOT_TOKEN: '100000001:e2e-only-telegram-bot-token-0123456789',
}

log('запускаю api')
// cwd is services/api: from there the server finds the native argon2.
start('api', 'node', ['dist/index.js'], { env: apiEnv, cwd: join(repoRoot, 'services', 'api') })
await waitFor(`http://127.0.0.1:${APP_PORT}/api/health`, 'api')

log('запускаю PWA')
// The preview config proxies `/api` (REST and the dialog WebSocket) to API_PROXY_TARGET, so the client
// talks to its own origin and needs no CORS. The meta tags the nginx image injects (site address,
// environment) are not there, which is fine: the client falls back to relative legal links.
start(
  'pwa',
  'pnpm',
  ['--filter', '@ryadom/mobile', 'exec', 'vite', 'preview', '--mode', 'web', '--host', '127.0.0.1', '--port', PWA_PORT, '--strictPort'],
  { env: { ...process.env, API_PROXY_TARGET: `http://127.0.0.1:${APP_PORT}` } },
)
await waitFor(`http://127.0.0.1:${PWA_PORT}/`, 'PWA')

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
    // "Open the app" leads to the web app; the download page also links the PWA.
    PUBLIC_WEBAPP_URL: `http://127.0.0.1:${WEBAPP_PORT}`,
    PUBLIC_PWA_URL: `http://127.0.0.1:${PWA_PORT}`,
    PUBLIC_SUPPORT_EMAIL: 'support@ryadom.local',
  },
})
await waitFor(`http://127.0.0.1:${WEB_PORT}/api/health`, 'сайт')

log('стек готов')
