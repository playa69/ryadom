#!/usr/bin/env node
// Runs docker with the given arguments. On Windows without docker in PATH it goes through WSL
// (wsl maps the current directory to /mnt/c/... itself, so relative paths work).
//
// Also a module: scripts/stand.mjs and the e2e stack call docker() instead of building the command themselves.
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

let viaWsl
/** True when docker is only reachable through WSL (Windows without a native docker). */
export function usesWsl() {
  if (viaWsl === undefined) {
    // One command string: with a shell and an argument list Node warns, and a docker.cmd shim needs the shell.
    viaWsl =
      process.platform === 'win32' &&
      spawnSync('docker --version', { stdio: 'ignore', shell: true }).status !== 0
  }
  return viaWsl
}

// Variables a compose file reads: the stand's ports and labels (see stand-ports.mjs) and the mock image tag.
const COMPOSE_VARIABLE = /^(STAND_|DEV_|E2E_|FULL_|AGENT_MOCK_TAG$|COMPOSE_)/

/** Through WSL only the variables listed in WSLENV get across, so the compose ones are listed there. */
export function dockerEnv(env = process.env) {
  const names = Object.keys(env).filter((name) => COMPOSE_VARIABLE.test(name))
  return { ...env, WSLENV: [env.WSLENV, ...names].filter(Boolean).join(':') }
}

const withoutNul = (text) => String(text ?? '').replaceAll('\0', '')

/** Runs `docker <args>`. Output goes to the terminal unless `capture` is set, then it is returned. */
export function docker(args, { env = process.env, capture = false, cwd } = {}) {
  const [command, argv] = usesWsl() ? ['wsl', ['docker', ...args]] : ['docker', args]
  const result = spawnSync(command, argv, {
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: dockerEnv(env),
    cwd,
    encoding: 'utf8',
  })
  return { status: result.status ?? 1, stdout: withoutNul(result.stdout), stderr: withoutNul(result.stderr) }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(docker(process.argv.slice(2)).status)
}
