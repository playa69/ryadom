/**
 * Stand identity and ports: which ports, compose projects and addresses a working copy uses.
 *
 * Several agents work on one machine, each in its own git worktree, and every stack they start (development
 * servers, the e2e stack, unit-test databases) used to sit on fixed ports under fixed compose project names.
 * A worktree now has a "stand": an id (the worktree folder name, STAND_ID overrides it) and a slot number.
 * Slot N >= 1 owns the ports 20000 + 100 * N + k for the development stack and 20000 + 100 * N + 50 + k for
 * the e2e stack (k is the index in PORT_NAMES). Slot 0 is the old fixed layout: nothing set means slot 0, so a
 * person who runs `pnpm dev` by hand keeps every address as it was.
 *
 * This module only reads (the pin app/.stand.json, the machine registry) and computes. Taking a slot, which
 * writes, is scripts/stand.mjs. It has no side effects on import, so playwright.config.ts, the e2e stack, the
 * screenshot scripts and the test-database helper can all share it.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Index in this list is k in the port formula. */
export const PORT_NAMES = [
  'landing', // 0
  'admin', // 1
  'api', // 2
  'web', // 3
  'pwa', // 4
  'mock', // 5 agent mock
  'mailUi', // 6 Mailpit web UI
  'mailSmtp', // 7 Mailpit SMTP
  'postgres', // 8
  'redis', // 9
  'agent', // 10 the Python agent
  'studio', // 11 drizzle studio
]

export const SLOT_BASE = 20000
export const SLOT_STEP = 100
export const E2E_SHIFT = 50
/** Highest slot whose last port stays below 49152, where the OS hands out ephemeral ports. */
export const MAX_SLOT = 290

/** Slot 0: the addresses the repository always used. E2E has no admin, redis, agent or studio; the numbers are placeholders. */
const LEGACY = {
  dev: {
    landing: 3000,
    admin: 3001,
    api: 3002,
    web: 3003,
    pwa: 5174,
    mock: 8080,
    mailUi: 8026,
    mailSmtp: 1026,
    postgres: 55433,
    redis: 56379,
    agent: 8001,
    studio: 4983,
  },
  e2e: {
    landing: 3100,
    admin: 3101,
    api: 3102,
    web: 3103,
    pwa: 3104,
    mock: 8081,
    mailUi: 8027,
    mailSmtp: 1027,
    postgres: 55434,
    redis: 56380,
    agent: 8002,
    studio: 4984,
  },
}

/** The folder with app/package.json, whichever worktree this file came from. */
export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const isWindows = process.platform === 'win32'

/** A compose project, container label and database name must be plain: lower case letters, digits, dashes. */
export function sanitizeId(raw) {
  const id = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  if (!id) throw new Error(`STAND_ID "${raw}" has no letters or digits`)
  return id
}

export function portsFor(slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot > MAX_SLOT) {
    throw new Error(`slot ${slot} is out of range 0..${MAX_SLOT}`)
  }
  if (slot === 0) return { dev: { ...LEGACY.dev }, e2e: { ...LEGACY.e2e } }
  const base = SLOT_BASE + SLOT_STEP * slot
  const at = (offset) => Object.fromEntries(PORT_NAMES.map((name, k) => [name, base + offset + k]))
  return { dev: at(0), e2e: at(E2E_SHIFT) }
}

/** Every port a slot owns, both stacks, for probing. Slot 0 skips the placeholders nothing listens on. */
export function allPorts(slot) {
  const { dev, e2e } = portsFor(slot)
  return [...new Set([...Object.values(dev), ...Object.values(e2e)])].sort((a, b) => a - b)
}

/** The part of compose project names after "ryadom-": a worktree folder is usually called ryadom-something already. */
export const projectStem = (id) => (id.startsWith('ryadom-') ? id : `ryadom-${id}`)

/** The worktree's own id: its folder name. app/ sits directly in the repository root. */
export function defaultId(appRoot = APP_ROOT) {
  return sanitizeId(basename(dirname(appRoot)))
}

/** Where the machine-wide registry lives. RYADOM_STANDS_DIR overrides it (tests, unusual setups). */
export function registryDir(env = process.env) {
  if (env.RYADOM_STANDS_DIR) return env.RYADOM_STANDS_DIR
  if (isWindows) return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'ryadom-stands')
  return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'ryadom-stands')
}

export const sameDir = (a, b) => {
  const [x, y] = [resolve(a), resolve(b)]
  return isWindows ? x.toLowerCase() === y.toLowerCase() : x === y
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** The pin in the worktree: app/.stand.json, not in git. */
export function readPin(appRoot = APP_ROOT) {
  return readJson(join(appRoot, '.stand.json'))
}

/** Every slot record of the machine registry (slots/N.json). */
export function readRecords(env = process.env) {
  const dir = join(registryDir(env), 'slots')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => /^\d+\.json$/.test(name))
    .map((name) => readJson(join(dir, name)))
    .filter((record) => record && Number.isInteger(record.slot))
    .sort((a, b) => a.slot - b.slot)
}

function parseSlot(raw) {
  const slot = Number(raw)
  if (!Number.isInteger(slot) || slot < 0 || slot > MAX_SLOT)
    throw new Error(`STAND_SLOT=${raw}: expected an integer 0..${MAX_SLOT}`)
  return slot
}

const urlsOf = (ports, host) => {
  const http = (name) => `http://${host}:${ports[name]}`
  return {
    landing: http('landing'),
    admin: http('admin'),
    api: http('api'),
    web: http('web'),
    pwa: http('pwa'),
    mock: http('mock'),
    mail: http('mailUi'),
    agent: http('agent'),
  }
}

/**
 * Everything a script needs to know about its stand. Never allocates: a worktree without a slot gets slot 0.
 * Slot comes from STAND_SLOT, then the pin (when it belongs to this id), then the registry (an id that was
 * set through STAND_ID and has no pin), then 0.
 */
export function resolveStand({ appRoot = APP_ROOT, env = process.env } = {}) {
  const worktree = dirname(appRoot)
  const id = env.STAND_ID ? sanitizeId(env.STAND_ID) : defaultId(appRoot)
  let slot = null
  let source = 'legacy'
  if (env.STAND_SLOT !== undefined && env.STAND_SLOT !== '') {
    slot = parseSlot(env.STAND_SLOT)
    source = 'env'
  }
  if (slot === null) {
    const pin = readPin(appRoot)
    if (pin?.id === id && Number.isInteger(pin.slot)) {
      slot = pin.slot
      source = 'pin'
    }
  }
  if (slot === null) {
    const record = readRecords(env).find((r) => r.id === id && r.appRoot && sameDir(r.appRoot, appRoot))
    if (record) {
      slot = record.slot
      source = 'registry'
    }
  }
  if (slot === null) slot = 0
  return describeStand({ id, slot, source, appRoot, worktree })
}

export function describeStand({ id, slot, source, appRoot, worktree }) {
  const ports = portsFor(slot)
  // Slot 0 keeps "localhost" for development: .env.local files and the docs always said so.
  const devHost = slot === 0 ? 'localhost' : '127.0.0.1'
  const dbUrl = (port, db = 'ryadom') => `postgres://ryadom:ryadom@127.0.0.1:${port}/${db}`
  return {
    id,
    slot,
    source,
    appRoot,
    worktree,
    ports,
    projects:
      slot === 0
        ? { dev: 'ryadom-dev', e2e: 'ryadom-e2e', full: 'ryadom' }
        : { dev: `${projectStem(id)}-dev`, e2e: `${projectStem(id)}-e2e`, full: `${projectStem(id)}-full` },
    urls: { dev: urlsOf(ports.dev, devHost), e2e: urlsOf(ports.e2e, '127.0.0.1') },
    databases: {
      dev: dbUrl(ports.dev.postgres),
      e2e: dbUrl(ports.e2e.postgres),
      /** The unit tests create their own databases through the dev server, from the maintenance database. */
      admin: dbUrl(ports.dev.postgres, 'postgres'),
    },
    /** Runtime state of the stand (pids, logs); not in git. */
    stateDir: join(appRoot, '.stand', id),
  }
}

/**
 * The variables other processes read. Compose files take the *_PORT ones; scripts and Playwright the URLs;
 * the names that already existed (E2E_WEB_URL, E2E_DATABASE_URL, ...) keep their meaning.
 */
export function standEnv(stand) {
  const { dev, e2e } = stand.ports
  const u = stand.urls
  // The whole-stack compose (app/docker-compose.yaml) serves the PWA from nginx on 3004 in slot 0, where the
  // development server of the PWA is on 5174; in the other slots both are the same port of the map.
  const full = stand.slot === 0 ? { ...dev, pwa: 3004 } : dev
  return {
    STAND_ID: stand.id,
    STAND_SLOT: String(stand.slot),
    STAND_WORKTREE: stand.worktree,
    STAND_PROJECT_DEV: stand.projects.dev,
    STAND_PROJECT_E2E: stand.projects.e2e,
    STAND_PROJECT_FULL: stand.projects.full,
    DEV_PG_PORT: String(dev.postgres),
    DEV_REDIS_PORT: String(dev.redis),
    DEV_MAIL_SMTP_PORT: String(dev.mailSmtp),
    DEV_MAIL_UI_PORT: String(dev.mailUi),
    DEV_AGENT_MOCK_PORT: String(dev.mock),
    DEV_LANDING_PORT: String(dev.landing),
    DEV_ADMIN_PORT: String(dev.admin),
    DEV_API_PORT: String(dev.api),
    DEV_WEB_PORT: String(dev.web),
    DEV_PWA_PORT: String(dev.pwa),
    DEV_AGENT_PORT: String(dev.agent),
    DEV_STUDIO_PORT: String(dev.studio),
    FULL_LANDING_PORT: String(full.landing),
    FULL_ADMIN_PORT: String(full.admin),
    FULL_API_PORT: String(full.api),
    FULL_WEB_PORT: String(full.web),
    FULL_PWA_PORT: String(full.pwa),
    FULL_MAIL_UI_PORT: String(full.mailUi),
    E2E_PG_PORT: String(e2e.postgres),
    E2E_MAIL_SMTP_PORT: String(e2e.mailSmtp),
    E2E_MAIL_UI_PORT: String(e2e.mailUi),
    E2E_AGENT_MOCK_PORT: String(e2e.mock),
    DATABASE_URL: stand.databases.dev,
    E2E_DATABASE_URL: stand.databases.e2e,
    TEST_DB_ADMIN_URL: stand.databases.admin,
    AGENT_API_URL: u.dev.mock,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(dev.mailSmtp),
    STAND_URL_LANDING: u.dev.landing,
    STAND_URL_ADMIN: u.dev.admin,
    STAND_URL_API: u.dev.api,
    STAND_URL_WEB: u.dev.web,
    STAND_URL_PWA: u.dev.pwa,
    STAND_URL_MAIL: u.dev.mail,
    STAND_URL_AGENT_MOCK: u.dev.mock,
    // The e2e names keep their old meaning: WEB is the landing site, APP the API, WEBAPP the signed-in web app.
    E2E_WEB_URL: u.e2e.landing,
    E2E_APP_URL: u.e2e.api,
    E2E_WEBAPP_URL: u.e2e.web,
    E2E_PWA_URL: u.e2e.pwa,
    E2E_MAIL_URL: u.e2e.mail,
    E2E_AGENT_URL: u.e2e.mock,
  }
}

/** The part of the stand that is written to app/.stand.json for readers that do not import this module. */
export function pinOf(stand, extra = {}) {
  return {
    id: stand.id,
    slot: stand.slot,
    worktree: stand.worktree,
    appRoot: stand.appRoot,
    ports: stand.ports,
    projects: stand.projects,
    urls: stand.urls,
    databases: stand.databases,
    ...extra,
  }
}
