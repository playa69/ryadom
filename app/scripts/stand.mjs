#!/usr/bin/env node
/**
 * The stand of a worktree: its slot, its containers, its servers, its test runs.
 *
 *   pnpm stand:up [--only a,b] [--infra-only] [--e2e]   start the development stand (or the e2e stack with --e2e)
 *   pnpm stand:env [--shell|--ps|--json]                  addresses and variables of this stand
 *   pnpm stand:down [--release]                           stop everything this stand started
 *   pnpm stand:ls                                         every stand of the machine
 *   pnpm stand:gc [--dry-run]                             free the slots of removed or long idle worktrees
 *   pnpm stand:run -- <command>                           run a command with the stand's variables
 *   pnpm test [turbo args]                                unit tests, each run in a database of its own
 *   pnpm e2e [playwright args]                            the e2e suite on this stand's ports
 *   pnpm evidence <TASK> [playwright args]                e2e with a screenshot per step (EVIDENCE=<TASK>)
 *   pnpm stand:lock <name> -- <command>                   run a command under a machine-wide lock (the Android emulator)
 *
 * What a stand is, and the port map: stand-ports.mjs. This file is the part that writes: it takes a slot in the
 * machine registry (%LOCALAPPDATA%\ryadom-stands\slots\N.json, created through mkdir so that two agents never take
 * the same one), pins it in app/.stand.json, and starts and stops what runs on the slot's ports. It is also a
 * module: the e2e stack uses its helpers to kill process trees and to refuse busy ports.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import net from 'node:net'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { docker } from './docker.mjs'
import {
  APP_ROOT,
  MAX_SLOT,
  allPorts,
  defaultId,
  describeStand,
  pinOf,
  projectStem,
  readPin,
  readRecords,
  registryDir,
  resolveStand,
  sameDir,
  standEnv,
} from './stand-ports.mjs'

const isWindows = process.platform === 'win32'
const LABEL = 'com.ryadom.stand'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// To stderr: stdout of stand commands is data (`stand env --shell | eval`, a screenshot piped through `stand lock`).
export const log = (message) => process.stderr.write(`[stand] ${message}\n`)

// ── processes ──────────────────────────────────────────────────────────────────────────────────────────────

export function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * Kills a process with everything it started. `child.kill()` ends only the process itself, and a `shell: true`
 * child on Windows is cmd.exe, so the node server behind it kept running and kept its port.
 */
export function killTree(pid) {
  if (!pid) return
  if (isWindows) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(-pid, 'SIGTERM') // the group, when it was started detached
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Already gone.
    }
  }
}

/** When a process started, in ms since the epoch, or null. Used to tell our pid from a stranger that got the number later. */
function startTimeOf(pid) {
  const command = isWindows
    ? spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
        ],
        { encoding: 'utf8' },
      )
    : spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' })
  if (command.status !== 0) return null
  const time = Date.parse(isWindows ? command.stdout.trim() : `${command.stdout.trim()} UTC`)
  return Number.isNaN(time) ? null : time
}

/** True when `entry` ({ pid, startedAt }) still is the process we started. */
export function isOurs(entry) {
  if (!isAlive(entry.pid)) return false
  const started = startTimeOf(entry.pid)
  // Unknown start time: do not kill what cannot be recognised.
  return started !== null && Math.abs(started - entry.startedAt) < 60_000
}

// pnpm and npm are .cmd shims on Windows, which only a shell starts. Everything else is started as it is, so that an
// argument with spaces stays one argument; the shim line is quoted by hand for the same reason.
const SHIM = /^(pnpm|npm|npx|yarn|corepack)$/i
const quoteArg = (arg) => (/^[w@%+=:,./\-]+$/.test(arg) ? arg : `"${arg.replaceAll('"', '\\"')}"`)
const shimLine = (command, args) => [command, ...args.map(quoteArg)].join(' ')
const viaShell = (command) => isWindows && SHIM.test(command)

export function spawnCommand(command, args, options = {}) {
  return viaShell(command)
    ? spawn(shimLine(command, args), { ...options, shell: true })
    : spawn(command, args, options)
}

export function spawnCommandSync(command, args, options = {}) {
  return viaShell(command)
    ? spawnSync(shimLine(command, args), { ...options, shell: true })
    : spawnSync(command, args, options)
}

// ── ports ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Tries to listen on a port: busy (EADDRINUSE) and reserved by Windows (EACCES) both mean "not ours to take". */
export function probePort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (error) => resolve({ port, free: false, code: error.code }))
    server.listen({ port, host }, () => server.close(() => resolve({ port, free: true })))
  })
}

export async function busyPorts(ports) {
  const results = await Promise.all(ports.map((port) => probePort(port)))
  return results.filter((result) => !result.free)
}

export async function waitHttp(url, what, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline)
      throw new Error(`${what} did not answer in ${Math.round(timeoutMs / 1000)} s: ${url}`)
    await sleep(500)
  }
}

// ── files ──────────────────────────────────────────────────────────────────────────────────────────────────

function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** Written next to the target and renamed, so a reader never sees half a file. */
function writeJson(file, data) {
  mkdirSync(join(file, '..'), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`)
  renameSync(temporary, file)
}

const slotsDir = () => join(registryDir(), 'slots')
const recordFile = (slot) => join(slotsDir(), `${slot}.json`)

// ── machine locks ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * A lock is a directory: mkdir either creates it or fails, atomically, on every file system. It holds the pid of
 * the owner, so a lock left by a process that died is taken over instead of blocking everybody.
 */
function tryLock(dir) {
  try {
    mkdirSync(dir)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const owner = readJson(join(dir, 'owner.json'))
    // No owner file for a minute: the creator died between mkdir and the write.
    const abandoned = owner ? !isAlive(owner.pid) : Date.now() - statSync(dir).mtimeMs > 60_000
    if (!abandoned) return false
    rmSync(dir, { recursive: true, force: true })
    return tryLock(dir)
  }
  writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, since: Date.now() }))
  return true
}

const unlock = (dir) => rmSync(dir, { recursive: true, force: true })

export async function withMachineLock(name, action, { timeoutMs = 10 * 60_000 } = {}) {
  const dir = join(registryDir(), 'locks', name)
  mkdirSync(join(dir, '..'), { recursive: true })
  const deadline = Date.now() + timeoutMs
  let waited = false
  while (!tryLock(dir)) {
    if (!waited) log(`lock "${name}" is held by another process, waiting`)
    waited = true
    if (Date.now() > deadline)
      throw new Error(`lock "${name}" was not released in ${Math.round(timeoutMs / 1000)} s`)
    await sleep(1000)
  }
  try {
    return await action()
  } finally {
    unlock(dir)
  }
}

// ── registry ───────────────────────────────────────────────────────────────────────────────────────────────

function gitInfo(worktree) {
  const git = (...args) => {
    const result = spawnSync('git', ['-C', worktree, ...args], { encoding: 'utf8' })
    return result.status === 0 ? result.stdout.trim() : null
  }
  return { branch: git('rev-parse', '--abbrev-ref', 'HEAD'), commit: git('rev-parse', '--short', 'HEAD') }
}

/** Takes the lowest free slot whose every port can be listened on right now. One claim at a time on the machine. */
function claimSlot(identity) {
  mkdirSync(slotsDir(), { recursive: true })
  return withMachineLock('slot-claim', () => claimFreeSlot(identity), { timeoutMs: 60_000 })
}

async function claimFreeSlot({ id, appRoot, worktree }) {
  // Another terminal of the same worktree may have taken a slot while this one waited for the lock.
  const mine = readRecords().find((record) => record.id === id && sameDir(record.appRoot, appRoot))
  if (mine) return { ...mine, reused: true }
  // Same id, or ids that give the same compose project names ("foo" and "ryadom-foo"), in another live worktree.
  const clash = readRecords().find(
    (record) =>
      projectStem(record.id) === projectStem(id) &&
      !sameDir(record.appRoot, appRoot) &&
      existsSync(record.appRoot),
  )
  if (clash) throw new Error(`STAND_ID "${id}" is taken by ${clash.worktree}; set STAND_ID to another name`)
  for (const record of readRecords()) {
    // The worktree of a record is gone: nothing can be running from it, so the number is free again. Containers it
    // left behind hold their ports, which the probe below notices; stand:gc removes them.
    if (!existsSync(record.appRoot)) rmSync(recordFile(record.slot), { force: true })
  }
  for (let slot = 1; slot <= MAX_SLOT; slot++) {
    if (existsSync(recordFile(slot))) continue
    const lock = join(slotsDir(), `${slot}.lock`)
    if (!tryLock(lock)) continue
    try {
      if (existsSync(recordFile(slot))) continue
      const busy = await busyPorts(allPorts(slot))
      if (busy.length) {
        log(
          `slot ${slot} skipped: port ${busy[0].port} is ${busy[0].code === 'EACCES' ? 'reserved by the system' : 'in use'}`,
        )
        continue
      }
      const record = {
        slot,
        id,
        worktree,
        appRoot,
        createdAt: Date.now(),
        heartbeat: Date.now(),
        ...gitInfo(worktree),
      }
      writeJson(recordFile(slot), record)
      return record
    } finally {
      unlock(lock)
    }
  }
  throw new Error(`no free slot among 1..${MAX_SLOT}: run pnpm stand:gc`)
}

function touchRecord(slot) {
  const record = readJson(recordFile(slot))
  if (record) writeJson(recordFile(slot), { ...record, heartbeat: Date.now(), ...gitInfo(record.worktree) })
}

/**
 * The stand of the current worktree, with a slot of its own. A worktree that has none takes one (registry and
 * the pin app/.stand.json); one that has keeps it, and the registry learns that it is alive.
 * STAND_SLOT in the environment is taken as it is: slot 0 is the old fixed layout and is not in the registry.
 */
export async function ensureStand({ appRoot = APP_ROOT, env = process.env } = {}) {
  let stand = resolveStand({ appRoot, env })
  if (stand.source === 'env') return stand
  const registered = stand.slot > 0 ? readJson(recordFile(stand.slot)) : null
  const valid = registered && registered.id === stand.id && sameDir(registered.appRoot, appRoot)
  if (valid) {
    touchRecord(stand.slot)
  } else {
    const record = await claimSlot({ id: stand.id, appRoot, worktree: stand.worktree })
    stand = describeStand({
      id: record.id,
      slot: record.slot,
      source: 'registry',
      appRoot,
      worktree: stand.worktree,
    })
    if (!record.reused) {
      log(
        `stand "${stand.id}" took slot ${stand.slot} (ports ${stand.ports.dev.landing}..${stand.ports.e2e.studio})`,
      )
    }
  }
  if (stand.id === defaultId(appRoot)) {
    const pin = readPin(appRoot)
    if (!pin || pin.slot !== stand.slot || pin.id !== stand.id)
      writeJson(join(appRoot, '.stand.json'), pinOf(stand, gitInfo(stand.worktree)))
  }
  return stand
}

function releaseStand(stand) {
  if (stand.slot > 0) rmSync(recordFile(stand.slot), { force: true })
  if (stand.id === defaultId(stand.appRoot)) rmSync(join(stand.appRoot, '.stand.json'), { force: true })
  rmSync(stand.stateDir, { recursive: true, force: true })
}

/** Keeps the registry told that this stand is in use while a long command runs. */
function startHeartbeat(stand) {
  if (stand.slot === 0) return () => {}
  const timer = setInterval(() => touchRecord(stand.slot), 60_000)
  timer.unref()
  return () => clearInterval(timer)
}

// ── state of what a stand started ──────────────────────────────────────────────────────────────────────────

const stateFile = (stand) => join(stand.stateDir, 'state.json')
export const readState = (stand) => readJson(stateFile(stand), { processes: {} })
const writeState = (stand, state) => writeJson(stateFile(stand), state)

/** Notes a process the stand started, so that `stand:down` can end it whoever left it running. */
export function recordProcess(stand, name, entry) {
  const state = readState(stand)
  state.processes[name] = entry
  writeState(stand, state)
}

export function forgetProcess(stand, name) {
  const state = readState(stand)
  delete state.processes[name]
  writeState(stand, state)
}

function liveProcesses(stand) {
  return Object.entries(readState(stand).processes).filter(([, entry]) => isOurs(entry))
}

// ── docker ─────────────────────────────────────────────────────────────────────────────────────────────────

function stackEnv(stand, extra = {}) {
  return { ...process.env, ...standEnv(stand), ...extra }
}

const COMPOSE = {
  dev: (stand) => ['dev/compose.yaml', ...(stand.slot > 0 ? ['dev/compose.tmpfs.yaml'] : [])],
  e2e: () => ['e2e/compose.yaml'],
  full: () => ['docker-compose.yaml'],
}

/** `docker compose` for one of the stand's projects: its own name, its own ports, the labels of its owner. */
export function compose(stand, kind, args, extraEnv = {}) {
  const files = COMPOSE[kind](stand).flatMap((file) => ['-f', file])
  return docker(['compose', '-p', stand.projects[kind], ...files, ...args], {
    env: stackEnv(stand, extraEnv),
    cwd: stand.appRoot,
  })
}

/** Every file of dev/agent-mock, line endings normalised, so that two checkouts of one commit hash alike. */
function hashDirectory(dir) {
  const hash = createHash('sha256')
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name === 'node_modules') continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else
        hash.update(
          `${relative(dir, path).replaceAll('\\', '/')}\0${readFileSync(path, 'utf8').replaceAll('\r\n', '\n')}\0`,
        )
    }
  }
  walk(dir)
  return hash.digest('hex').slice(0, 12)
}

/**
 * The agent mock image, one per machine: its tag is the hash of its sources, so every stand with the same mock
 * uses the same image and a changed mock gets a new one. Returns the tag for AGENT_MOCK_TAG.
 */
export async function ensureMockImage(stand) {
  const tag = hashDirectory(join(stand.appRoot, 'dev', 'agent-mock'))
  const reference = `ryadom-agent-mock:${tag}`
  const present = () => docker(['image', 'inspect', reference], { capture: true }).status === 0
  if (present()) return tag
  await withMachineLock('mock-image', async () => {
    if (present()) return // another stand built it while we waited
    log(`building the agent mock image ${reference}`)
    const build = docker(['build', '-t', reference, 'dev/agent-mock'], { cwd: stand.appRoot })
    if (build.status !== 0) throw new Error('docker build of the agent mock failed')
  })
  return tag
}

/** Removes containers, volumes and networks that carry the stand's label, whatever compose project they belong to. */
function removeByLabel(id) {
  const filter = ['--filter', `label=${LABEL}=${id}`]
  const ids = (args) => docker(args, { capture: true }).stdout.split(/\s+/).filter(Boolean)
  const containers = ids(['ps', '-aq', ...filter])
  if (containers.length) docker(['rm', '-f', '-v', ...containers], { capture: true })
  const volumes = ids(['volume', 'ls', '-q', ...filter])
  if (volumes.length) docker(['volume', 'rm', '-f', ...volumes], { capture: true })
  const networks = ids(['network', 'ls', '-q', ...filter])
  if (networks.length) docker(['network', 'rm', ...networks], { capture: true })
  return containers.length
}

/** { id → number of containers } for every stand that has containers; `running` leaves out the stopped ones. */
function containersByStand({ running }) {
  const result = docker(
    ['ps', ...(running ? [] : ['-a']), '--filter', `label=${LABEL}`, '--format', `{{.Label "${LABEL}"}}`],
    { capture: true },
  )
  if (result.status !== 0) return null
  const counts = {}
  for (const id of result.stdout.split(/\s+/).filter(Boolean)) counts[id] = (counts[id] ?? 0) + 1
  return counts
}

// ── the development stand ──────────────────────────────────────────────────────────────────────────────────

const INFRA = { postgres: 'postgres', mailpit: 'mailpit', redis: 'redis', mock: 'agent-mock' }
const SERVERS = ['api', 'web', 'landing', 'admin', 'pwa']

const toolPath = (stand, dir, ...rest) => join(stand.appRoot, dir, 'node_modules', ...rest)

/** How each development server is started, straight through node: no shell, so there is one process to kill. */
function serverCommand(stand, name) {
  const { dev } = stand.ports
  const nextDev = (dir, port) => ({
    dir,
    args: [
      toolPath(stand, dir, 'next', 'dist', 'bin', 'next'),
      'dev',
      '--port',
      String(port),
      '--hostname',
      '127.0.0.1',
    ],
  })
  switch (name) {
    case 'api':
      return {
        dir: 'services/api',
        args: [
          toolPath(stand, 'services/api', 'tsx', 'dist', 'cli.mjs'),
          'watch',
          '--tsconfig',
          'tsconfig.dev.json',
          '--env-file-if-exists=.env.local',
          'src/index.ts',
        ],
        port: dev.api,
        health: '/api/health',
      }
    case 'web':
      return { ...nextDev('apps/web', dev.web), port: dev.web, health: '/api/health' }
    case 'landing':
      return { ...nextDev('apps/landing', dev.landing), port: dev.landing, health: '/api/health' }
    case 'admin':
      return { ...nextDev('apps/admin', dev.admin), port: dev.admin, health: '/api/health' }
    case 'pwa':
      return {
        dir: 'apps/mobile',
        args: [
          toolPath(stand, 'apps/mobile', 'vite', 'bin', 'vite.js'),
          '--mode',
          'dev',
          '--port',
          String(dev.pwa),
          '--strictPort',
        ],
        port: dev.pwa,
        health: '/',
      }
    default:
      throw new Error(`unknown component "${name}"`)
  }
}

/** The values .env.example gives, pointed at the stand's own ports. Variables already set in the environment win over .env.local. */
function serverEnv(stand, name) {
  const { dev } = stand.ports
  const url = stand.urls.dev
  const mail = {
    EMAIL_TRANSPORT: 'smtp',
    EMAIL_FROM: 'Рядом <noreply@ryadom.local>',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(dev.mailSmtp),
  }
  const secrets = {
    AUTH_SECRET: 'local-only-auth-secret-change-me-0123456789',
    MOBILE_JWT_SECRET: 'local-only-mobile-jwt-secret-change-me-0123',
  }
  const base = { ...stackEnv(stand), NEXT_TELEMETRY_DISABLED: '1' }
  switch (name) {
    case 'api':
      return {
        ...base,
        ...secrets,
        ...mail,
        APP_ENV: 'local',
        LOG_LEVEL: 'info',
        PORT: String(dev.api),
        PUBLIC_WEB_URL: url.landing,
        PUBLIC_APP_URL: url.api,
        PUBLIC_WEBAPP_URL: url.web,
        AGENT_API_URL: url.mock,
        AGENT_TIMEOUT_MS: '10000',
      }
    case 'admin':
      return {
        ...base,
        ...secrets,
        ...mail,
        APP_ENV: 'local',
        LOG_LEVEL: 'info',
        PORT: String(dev.admin),
        ADMIN_EMAILS: 'admin@ryadom.local',
        PUBLIC_WEB_URL: url.landing,
        PUBLIC_APP_URL: url.api,
        AGENT_API_URL: url.mock,
      }
    case 'web':
      return { ...base, PUBLIC_API_URL: url.api, PUBLIC_WEB_URL: url.landing }
    case 'landing':
      return {
        ...base,
        PUBLIC_WEBAPP_URL: url.web,
        PUBLIC_PWA_URL: `${url.pwa}/`,
        PUBLIC_APP_URL: url.api,
        PUBLIC_SUPPORT_EMAIL: 'support@ryadom.local',
      }
    case 'pwa':
      return { ...base, API_PROXY_TARGET: url.api }
    default:
      throw new Error(`unknown component "${name}"`)
  }
}

function startDetached(stand, name, command, args, { cwd, env, port }) {
  const logFile = join(stand.stateDir, 'logs', `${name}.log`)
  mkdirSync(join(logFile, '..'), { recursive: true })
  const out = openSync(logFile, 'a')
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  })
  child.unref()
  closeSync(out)
  recordProcess(stand, name, { pid: child.pid, startedAt: Date.now(), port, command, log: logFile })
  return logFile
}

function tail(file, lines = 15) {
  try {
    return readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n')
  } catch {
    return '(no log)'
  }
}

async function startServer(stand, name) {
  const command = serverCommand(stand, name)
  const state = readState(stand).processes[name]
  if (state && isOurs(state)) {
    log(`${name}: already running (pid ${state.pid}, port ${command.port})`)
    return command
  }
  const [busy] = await busyPorts([command.port])
  if (busy)
    throw new Error(
      `${name}: port ${command.port} is ${busy.code === 'EACCES' ? 'reserved by the system' : 'in use by another process'}`,
    )
  const logFile = startDetached(stand, name, name, command.args, {
    cwd: join(stand.appRoot, command.dir),
    env: serverEnv(stand, name),
    port: command.port,
  })
  log(`${name}: starting on ${command.port} (log ${relative(stand.appRoot, logFile)})`)
  return { ...command, logFile }
}

function runMigrations(stand) {
  log('applying migrations')
  const result = spawnSync(
    process.execPath,
    [toolPath(stand, 'packages/db', 'tsx', 'dist', 'cli.mjs'), 'src/cli/migrate.ts'],
    {
      cwd: join(stand.appRoot, 'packages', 'db'),
      env: stackEnv(stand),
      stdio: 'inherit',
    },
  )
  if (result.status !== 0) throw new Error('migrations failed')
}

function parseOnly(flags) {
  if (flags['infra-only']) return Object.keys(INFRA)
  if (!flags.only) return [...Object.keys(INFRA), ...SERVERS]
  const wanted = String(flags.only)
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  const known = [...Object.keys(INFRA), ...SERVERS, 'infra']
  const unknown = wanted.filter((name) => !known.includes(name))
  if (unknown.length)
    throw new Error(`--only: unknown ${unknown.join(', ')}; choose from ${known.join(', ')}`)
  return wanted.flatMap((name) => (name === 'infra' ? Object.keys(INFRA) : [name]))
}

export async function infraUp(stand, components) {
  const services = components.filter((name) => INFRA[name]).map((name) => INFRA[name])
  if (!services.length) return
  const env = {}
  if (services.includes('agent-mock')) env.AGENT_MOCK_TAG = await ensureMockImage(stand)
  log(`starting containers of project ${stand.projects.dev}: ${services.join(', ')}`)
  const all = services.length === Object.keys(INFRA).length
  const result = compose(stand, 'dev', ['up', '-d', '--wait', ...(all ? [] : services)], env)
  if (result.status !== 0) throw new Error('docker compose up failed')
}

async function cmdUp(flags) {
  const stand = await ensureStand()
  if (flags.e2e) return upE2e(stand)
  const components = parseOnly(flags)
  await infraUp(stand, components)
  if (components.includes('postgres') && !flags['no-migrate']) runMigrations(stand)
  const started = []
  for (const name of components.filter((component) => SERVERS.includes(component)))
    started.push([name, await startServer(stand, name)])
  const waits = started.map(async ([name, command]) => {
    try {
      await waitHttp(`http://127.0.0.1:${command.port}${command.health}`, name, 180_000)
    } catch (error) {
      throw new Error(
        `${error.message}\n--- last lines of the log of ${name}:\n${tail(command.logFile ?? readState(stand).processes[name]?.log)}`,
      )
    }
  })
  await Promise.all(waits)
  printAddresses(stand, components)
}

function printAddresses(stand, components) {
  const rows = []
  const url = stand.urls.dev
  const has = (name) => components.includes(name)
  if (has('landing')) rows.push(['landing', url.landing])
  if (has('admin')) rows.push(['admin', url.admin])
  if (has('api')) rows.push(['api', url.api])
  if (has('web')) rows.push(['web', url.web])
  if (has('pwa')) rows.push(['pwa', url.pwa])
  if (has('mock')) rows.push(['agent mock', url.mock])
  if (has('mailpit')) rows.push(['mailpit', `${url.mail}  (smtp ${stand.ports.dev.mailSmtp})`])
  if (has('postgres')) rows.push(['postgres', stand.databases.dev])
  if (has('redis')) rows.push(['redis', `redis://127.0.0.1:${stand.ports.dev.redis}`])
  log(`stand "${stand.id}", slot ${stand.slot}:`)
  for (const [name, value] of rows) process.stdout.write(`  ${name.padEnd(11)} ${value}\n`)
}

/** The e2e stack held by a detached process, for scripts that need it without Playwright (screenshots) or for E2E_REUSE=1. */
async function upE2e(stand) {
  const existing = readState(stand).processes['e2e-stack']
  if (existing && isOurs(existing)) {
    log(`the e2e stack already runs (pid ${existing.pid})`)
    return
  }
  const logFile = startDetached(
    stand,
    'e2e-stack',
    'e2e-stack',
    [join(stand.appRoot, 'e2e', 'scripts', 'stack.mjs')],
    {
      cwd: stand.appRoot,
      env: stackEnv(stand),
      port: stand.ports.e2e.landing,
    },
  )
  log(`building and starting the e2e stack (log ${relative(stand.appRoot, logFile)})`)
  const child = readState(stand).processes['e2e-stack']
  const deadline = Date.now() + 15 * 60_000
  for (;;) {
    if (!isAlive(child.pid)) throw new Error(`the e2e stack exited:\n${tail(logFile)}`)
    try {
      if (
        (await fetch(`${stand.urls.e2e.landing}/api/health`)).ok &&
        /стек готов/.test(readFileSync(logFile, 'utf8'))
      )
        break
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error(`the e2e stack did not come up:\n${tail(logFile)}`)
    await sleep(1000)
  }
  log(
    `e2e stack is up: landing ${stand.urls.e2e.landing}, web ${stand.urls.e2e.web}, pwa ${stand.urls.e2e.pwa}, api ${stand.urls.e2e.api}, mail ${stand.urls.e2e.mail}`,
  )
}

// ── stop, list, collect ────────────────────────────────────────────────────────────────────────────────────

/** Stops what the stand started: processes first (their pids are in the state file), then containers by label. */
function stopStand(stand) {
  const state = readState(stand)
  for (const [name, entry] of Object.entries(state.processes)) {
    if (isOurs(entry)) {
      log(`stopping ${name} (pid ${entry.pid})`)
      killTree(entry.pid)
    }
    delete state.processes[name]
  }
  writeState(stand, state)
  const removed = removeByLabel(stand.id)
  if (removed) log(`removed ${removed} container(s) of ${stand.id}`)
}

async function cmdDown(flags) {
  const stand = resolveStand()
  if (stand.source === 'legacy' && !flags.force) {
    log('this worktree has no stand yet: nothing to stop')
    return
  }
  stopStand(stand)
  if (flags.release) {
    releaseStand(stand)
    log(`slot ${stand.slot} released`)
  }
}

const age = (ms) => {
  const minutes = Math.round((Date.now() - ms) / 60_000)
  if (minutes < 90) return `${minutes} min`
  return minutes < 60 * 48 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 60 / 24)} d`
}

function cmdLs() {
  const running = containersByStand({ running: true })
  const mine = resolveStand()
  const rows = readRecords().map((record) => {
    const appRoot = record.appRoot
    const gone = !existsSync(appRoot)
    const processes = gone
      ? 0
      : liveProcesses(
          describeStand({
            id: record.id,
            slot: record.slot,
            source: 'registry',
            appRoot,
            worktree: record.worktree,
          }),
        ).length
    return [
      record.slot === mine.slot && record.id === mine.id ? '*' : ' ',
      String(record.slot),
      record.id,
      gone
        ? 'worktree gone'
        : `${running ? (running[record.id] ?? 0) : '?'} containers, ${processes} processes`,
      `${20000 + record.slot * 100}..${20000 + record.slot * 100 + 61}`,
      age(record.heartbeat),
      record.branch ?? '',
    ]
  })
  const header = [' ', 'slot', 'stand', 'running', 'ports', 'seen', 'branch']
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index].length)))
  const print = (row) =>
    process.stdout.write(
      `${row
        .map((cell, index) => cell.padEnd(widths[index]))
        .join('  ')
        .trimEnd()}\n`,
    )
  print(header)
  rows.forEach(print)
  if (!rows.length) process.stdout.write('(no stands registered)\n')
  if (running === null) process.stdout.write('(docker is not reachable: container counts unknown)\n')
  if (mine.source === 'legacy')
    process.stdout.write(
      'This worktree has no slot yet: it takes one on the first stand:up / test / e2e (slot 0 is the old fixed layout).\n',
    )
}

function cmdGc(flags) {
  const dry = Boolean(flags['dry-run'])
  const staleMs = Number(flags['stale-hours'] ?? process.env.STAND_STALE_HOURS ?? 48) * 3_600_000
  const running = containersByStand({ running: true })
  const existing = containersByStand({ running: false })
  const act = (message, action) => {
    log(`${dry ? 'would: ' : ''}${message}`)
    if (!dry) action()
  }
  // Taken before anything is freed: the containers of a slot this pass frees are dealt with together with the slot.
  const known = new Set(readRecords().map((record) => record.id))
  for (const record of readRecords()) {
    const stand = describeStand({
      id: record.id,
      slot: record.slot,
      source: 'registry',
      appRoot: record.appRoot,
      worktree: record.worktree,
    })
    if (!existsSync(record.appRoot)) {
      act(
        `slot ${record.slot} (${record.id}): worktree is gone, removing its containers and the slot`,
        () => {
          removeByLabel(record.id)
          rmSync(recordFile(record.slot), { force: true })
        },
      )
      continue
    }
    const idle = Date.now() - record.heartbeat > staleMs
    const busy = liveProcesses(stand).length > 0 || (running ? (running[record.id] ?? 0) > 0 : true)
    if (idle && !busy) {
      act(
        `slot ${record.slot} (${record.id}): idle for ${age(record.heartbeat)}, nothing running, freeing the slot`,
        () => {
          removeByLabel(record.id)
          releaseStand(stand)
        },
      )
    }
  }
  if (existing) {
    for (const id of Object.keys(existing)) {
      if (id !== 'manual' && !known.has(id))
        act(`containers of "${id}" belong to no slot, removing them`, () => removeByLabel(id))
    }
  }
  for (const name of existsSyncDir(join(registryDir(), 'slots'))) {
    if (
      name.endsWith('.lock') &&
      Date.now() - statSync(join(registryDir(), 'slots', name)).mtimeMs > 5 * 60_000
    ) {
      act(`removing the stale lock ${name}`, () =>
        rmSync(join(registryDir(), 'slots', name), { recursive: true, force: true }),
      )
    }
  }
}

const existsSyncDir = (dir) => (existsSync(dir) ? readdirSync(dir) : [])

// ── env / run ──────────────────────────────────────────────────────────────────────────────────────────────

async function cmdEnv(flags) {
  const stand = await ensureStand()
  const variables = standEnv(stand)
  const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`
  if (flags.json)
    process.stdout.write(
      `${JSON.stringify({ ...variables, ports: stand.ports, urls: stand.urls }, null, 2)}\n`,
    )
  else if (flags.shell)
    for (const [key, value] of Object.entries(variables))
      process.stdout.write(`export ${key}=${quote(value)}\n`)
  else if (flags.ps)
    for (const [key, value] of Object.entries(variables))
      process.stdout.write(`$env:${key} = '${String(value).replaceAll("'", "''")}'\n`)
  else for (const [key, value] of Object.entries(variables)) process.stdout.write(`${key}=${value}\n`)
}

/** Runs a command with the stand's variables and waits; the heartbeat ticks meanwhile. */
function runCommand(stand, command, args, { env, cwd = stand.appRoot } = {}) {
  const stopBeat = startHeartbeat(stand)
  return new Promise((resolve) => {
    const child = spawnCommand(command, args, { cwd, env: env ?? stackEnv(stand), stdio: 'inherit' })
    // Ctrl+C reaches the child through the console; this process waits for it instead of leaving it behind.
    const ignore = () => {}
    process.on('SIGINT', ignore)
    child.on('exit', (code, signal) => {
      stopBeat()
      process.off('SIGINT', ignore)
      resolve(code ?? (signal ? 1 : 0))
    })
    child.on('error', (error) => {
      log(`${command}: ${error.message}`)
      stopBeat()
      resolve(1)
    })
  })
}

async function cmdRun(rest) {
  if (!rest.length) throw new Error('usage: stand run -- <command> [args]')
  const stand = await ensureStand()
  return runCommand(stand, rest[0], rest.slice(1))
}

// ── unit tests ─────────────────────────────────────────────────────────────────────────────────────────────

async function cmdTest(rest) {
  const stand = await ensureStand()
  const [busy] = await busyPorts([stand.ports.dev.postgres])
  if (!busy) {
    log(`nothing listens on ${stand.ports.dev.postgres}: starting this stand's PostgreSQL`)
    await infraUp(stand, ['postgres'])
  }
  log(
    `unit tests of "${stand.id}": every run gets a database of its own on ${stand.databases.dev.replace(/\/ryadom$/, '')}`,
  )
  return runCommand(stand, 'pnpm', ['exec', 'turbo', 'run', 'test', '--filter=!@ryadom/e2e', ...rest])
}

// ── e2e ────────────────────────────────────────────────────────────────────────────────────────────────────

function e2eTeardown(stand) {
  const state = readState(stand)
  const entry = state.processes['e2e-stack']
  if (entry && isOurs(entry)) killTree(entry.pid)
  delete state.processes['e2e-stack']
  writeState(stand, state)
  // Playwright ends its web server by killing it, which on Windows gives the stack no chance to remove its containers.
  const result = compose(stand, 'e2e', ['down', '-v', '--remove-orphans'], {})
  if (result.status !== 0) log('docker compose down of the e2e project failed')
}

const e2ePorts = (stand) => {
  const { landing, api, web, pwa, mock, mailUi, mailSmtp, postgres } = stand.ports.e2e
  return [landing, api, web, pwa, mock, mailUi, mailSmtp, postgres]
}

/**
 * Before Playwright starts a stack of its own: a live stack of this stand is somebody's run and stays untouched
 * (the run is refused), the leftovers of a crashed one are cleared, and a port that is still busy belongs to
 * a stranger. Tests against a stranger's servers prove nothing, so none of this is left to chance.
 */
async function preflightE2e(stand) {
  const alive = readState(stand).processes['e2e-stack']
  if (alive && isOurs(alive)) {
    throw new Error(
      `the e2e stack of "${stand.id}" is already running (pid ${alive.pid}). Run the specs on it with E2E_REUSE=1, or stop it first: pnpm stand:down`,
    )
  }
  e2eTeardown(stand)
  const busy = await busyPorts(e2ePorts(stand))
  if (busy.length) {
    throw new Error(
      `ports of the e2e stack are in use by another process: ${busy.map((b) => b.port).join(', ')}. Nothing was started; another worktree's stack on the same ports? Take a slot of your own: pnpm stand:ls`,
    )
  }
}

async function answers(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(3000) })).ok
  } catch {
    return false
  }
}

async function cmdE2e(rest, extraEnv = {}) {
  const stand = await ensureStand()
  const env = stackEnv(stand, extraEnv)
  // E2E_REUSE=1 runs the specs on a stack that is already up and leaves it up; with none up it is an ordinary run.
  const reuse = env.E2E_REUSE === '1' && (await answers(`${stand.urls.e2e.landing}/api/health`))
  if (env.E2E_REUSE === '1' && !reuse) log('E2E_REUSE=1, but no stack answers: starting one for this run')
  if (!reuse) await preflightE2e(stand)
  // Playwright's own CLI, run by node directly: one process to wait for, and no shell between it and the stack.
  const cli = join(stand.appRoot, 'e2e', 'node_modules', '@playwright', 'test', 'cli.js')
  const code = await runCommand(stand, process.execPath, [cli, 'test', ...rest], {
    env,
    cwd: join(stand.appRoot, 'e2e'),
  })
  if (!reuse) e2eTeardown(stand)
  return code
}

async function cmdEvidence(rest) {
  const [task, ...playwrightArgs] = rest
  if (!task || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(task))
    throw new Error('usage: pnpm evidence <TASK> [playwright args], e.g. pnpm evidence PROTEUS-253 web-diary')
  const stand = await ensureStand()
  const dir = join(stand.appRoot, 'e2e', 'evidence', task)
  if (!playwrightArgs.includes('--keep')) rmSync(dir, { recursive: true, force: true })
  const code = await cmdE2e(
    playwrightArgs.filter((arg) => arg !== '--keep'),
    { EVIDENCE: task },
  )
  const manifest = readJson(join(dir, 'manifest.json'))
  if (!manifest) {
    log(`no screenshots taken: the specs called no step(). The fixture is e2e/support/evidence.ts`)
  } else {
    log(`${manifest.steps.length} screenshot(s) in ${relative(process.cwd(), dir) || dir}`)
    log(`index: ${join(dir, 'index.md')}`)
    const attachments = manifest.steps.map((step) => `--attachment ${join(dir, step.file)}`).join(' ')
    log(
      `for the Multica report: multica issue comment add <ID> --content-file ${join(dir, 'index.md')} ${attachments} --allow-external-file`,
    )
  }
  return code
}

// ── lock ───────────────────────────────────────────────────────────────────────────────────────────────────

async function cmdLock(rest, flags) {
  const [name, ...command] = rest
  if (!name || !command.length)
    throw new Error('usage: stand lock <name> [--timeout seconds] -- <command> [args]')
  return withMachineLock(
    name,
    () =>
      new Promise((resolve) => {
        const child = spawnCommand(command[0], command.slice(1), { stdio: 'inherit' })
        child.on('exit', (code) => resolve(code ?? 1))
        child.on('error', (error) => {
          log(`${command[0]}: ${error.message}`)
          resolve(1)
        })
      }),
    { timeoutMs: Number(flags.timeout ?? 600) * 1000 },
  )
}

// ── command line ───────────────────────────────────────────────────────────────────────────────────────────

/** `--flag`, `--flag value` and `--flag=value` before the first `--`; what follows it goes to the command untouched. */
function parseArgs(argv) {
  const flags = {}
  const rest = []
  const BOOLEAN = new Set([
    'e2e',
    'infra-only',
    'no-migrate',
    'release',
    'force',
    'dry-run',
    'shell',
    'ps',
    'json',
  ])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      rest.push(...argv.slice(i + 1))
      break
    }
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=')
      if (inline !== undefined) flags[key] = inline
      else if (BOOLEAN.has(key) || argv[i + 1] === undefined || argv[i + 1].startsWith('--'))
        flags[key] = true
      else flags[key] = argv[++i]
    } else {
      rest.push(arg)
    }
  }
  return { flags, rest }
}

async function main(argv) {
  const [command, ...tail] = argv
  // `pnpm e2e -- a b` hands the first `--` on as well.
  const afterCommand = tail[0] === '--' ? tail.slice(1) : tail
  switch (command) {
    case 'up':
      return cmdUp(parseArgs(tail).flags)
    case 'down':
      return cmdDown(parseArgs(tail).flags)
    case 'ls':
      return cmdLs()
    case 'gc':
      return cmdGc(parseArgs(tail).flags)
    case 'env':
      return cmdEnv(parseArgs(tail).flags)
    case 'run':
      return cmdRun(afterCommand)
    case 'test':
      return cmdTest(afterCommand)
    case 'e2e':
      return cmdE2e(afterCommand)
    case 'evidence':
      return cmdEvidence(afterCommand)
    case 'lock': {
      const { flags, rest } = parseArgs(tail)
      return cmdLock(rest, flags)
    }
    default:
      process.stderr.write(
        `usage: node scripts/stand.mjs up|down|ls|gc|env|run|test|e2e|evidence|lock (see the header of this file)\n`,
      )
      return 2
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(typeof code === 'number' ? code : 0),
    (error) => {
      process.stderr.write(`[stand] ${error.message}\n`)
      process.exit(1)
    },
  )
}
