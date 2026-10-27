#!/usr/bin/env node
/**
 * Brings up the stack for e2e and holds it until Playwright is done.
 *
 * Its own compose project and its own ports: a test run must not break the database used for
 * development (`pnpm stand:up` / `pnpm infra:up`). Which ports and which project come from the worktree's stand
 * (scripts/stand-ports.mjs): in a worktree that has a slot they are 20000 + 100 * slot + 50 + k, with no slot the
 * old fixed ones (55434 / 8081 / 3100 / 3102 / 3103 / 3104). playwright.config.ts computes the same addresses.
 * If any of those ports is taken the stack refuses to start: tests that ran against a stranger's servers
 * proved nothing.
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
import { spawn } from 'node:child_process'
import { cp } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { busyPorts, compose, ensureMockImage, forgetProcess, isOurs, killTree, readState, recordProcess, spawnCommandSync } from '../../scripts/stand.mjs'
import { resolveStand } from '../../scripts/stand-ports.mjs'

const e2eRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(e2eRoot, '..')

const stand = resolveStand({ appRoot: repoRoot })
const ports = stand.ports.e2e
const port = (name) => String(ports[name])

const DB_URL = stand.databases.e2e
// E2E_REAL_AGENT_URL runs the scenarios against a real agent (started locally, with a real model) instead of the mock.
const AGENT_URL = process.env.E2E_REAL_AGENT_URL ?? stand.urls.e2e.mock
// The landing site's env var is still called WEB_*: the legal pages live there. API is the API, WEBAPP the
// signed-in web app, PWA the PWA.
const WEB_PORT = port('landing')
const APP_PORT = port('api')
const WEBAPP_PORT = port('web')
const PWA_PORT = port('pwa')

const children = []
let shuttingDown = false

function log(message) {
  process.stdout.write(`[stack] ${message}\n`)
}

function composeDown() {
  // Always tear the containers down, including on failure: they hold a tmpfs database, and the
  // next run must start from an empty one.
  compose(stand, 'e2e', ['down', '-v', '--remove-orphans'])
}

function runSync(command, args, options = {}) {
  // pnpm is a .cmd shim on Windows, which spawnCommandSync starts through a shell; everything long-lived below is plain node.
  const result = spawnCommandSync(command, args, { stdio: 'inherit', cwd: repoRoot, ...options })
  if (result.status !== 0) {
    log(`команда упала: ${command} ${args.join(' ')}`)
    shutdown(result.status ?? 1)
  }
}

/** Runs a node script as a child. No shell between us and it, so killing the child ends the server. */
function start(name, args, options = {}) {
  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: repoRoot,
    ...options,
  })
  children.push({ name, child })
  recordProcess(stand, name, { pid: child.pid, startedAt: Date.now(), port: 0, command: name })
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
  // kill() on a child would end only that process; taskkill /T takes whatever it started too.
  for (const { name, child } of children) {
    killTree(child.pid)
    forgetProcess(stand, name)
  }
  composeDown()
  forgetProcess(stand, 'e2e-stack')
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

// A stack of this stand that is alive is somebody's run: clearing the containers below would pull the ground
// from under it, so it is refused before anything is touched.
const alive = readState(stand).processes['e2e-stack']
if (alive && alive.pid !== process.pid && isOurs(alive)) {
  log(`стек стенда "${stand.id}" уже запущен (pid ${alive.pid}). Остановить: pnpm stand:down; использовать готовый: E2E_REUSE=1`)
  process.exit(1)
}
recordProcess(stand, 'e2e-stack', { pid: process.pid, startedAt: Date.now() - process.uptime() * 1000, port: ports.landing, command: 'e2e-stack' })
log(`стенд "${stand.id}", слот ${stand.slot}: порты ${ports.landing}..${ports.postgres}`)

// A stack of this stand that a crashed run left behind would hold the ports and the database of the previous run.
composeDown()

const busy = await busyPorts([ports.landing, ports.api, ports.web, ports.pwa, ports.mock, ports.mailUi, ports.mailSmtp, ports.postgres])
if (busy.length) {
  const list = busy.map(({ port: p, code }) => `${p}${code === 'EACCES' ? ' (зарезервирован системой)' : ''}`).join(', ')
  log(`заняты порты стенда: ${list}. Чужой процесс? Тесты на чужом стенде ничего не доказывают, поэтому стек не стартует.`)
  log('Свои остатки снимает `pnpm stand:down`; работа в новом worktree: `pnpm e2e` сам берёт слот с другими портами.')
  shutdown(1)
}

log('поднимаю Postgres, Mailpit и заглушку агента')
// The mock image is one per machine, tagged with the hash of its sources: a changed mock gets a new tag, and an
// unchanged one is not built again.
const up = compose(stand, 'e2e', ['up', '-d', '--wait'], { AGENT_MOCK_TAG: await ensureMockImage(stand) })
if (up.status !== 0) {
  log('docker compose up не удался')
  shutdown(up.status)
}

log('применяю миграции')
runSync('pnpm', ['--filter', '@ryadom/db', 'migrate'], { env: { ...process.env, DATABASE_URL: DB_URL } })

/** The build-time switches of the web app's tests: both on by default, both off with `E2E_SELF_CHECK=0`. */
function selfCheckBuildEnv() {
  const on = process.env.E2E_SELF_CHECK === '0' ? '0' : '1'
  return { NEXT_PUBLIC_SELF_CHECK_ENABLED: on, NEXT_PUBLIC_SELF_CHECK_PREVIEW: on }
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
  SMTP_PORT: port('mailSmtp'),
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
start('api', ['dist/index.js'], { env: apiEnv, cwd: join(repoRoot, 'services', 'api') })
await waitFor(`http://127.0.0.1:${APP_PORT}/api/health`, 'api')

log('запускаю PWA')
// The preview config proxies `/api` (REST and the dialog WebSocket) to API_PROXY_TARGET, so the client
// talks to its own origin and needs no CORS. The meta tags the nginx image injects (site address,
// environment) are not there, which is fine: the client falls back to relative legal links.
start(
  'pwa',
  [join(repoRoot, 'apps', 'mobile', 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--mode', 'web', '--host', '127.0.0.1', '--port', PWA_PORT, '--strictPort'],
  { env: { ...process.env, API_PROXY_TARGET: `http://127.0.0.1:${APP_PORT}` }, cwd: join(repoRoot, 'apps', 'mobile') },
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
start('web', ['server.js'], {
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
start('landing', ['server.js'], {
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
