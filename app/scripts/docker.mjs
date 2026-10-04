#!/usr/bin/env node
// Runs docker with the given arguments. On Windows without docker in PATH it goes through WSL
// (wsl maps the current directory to /mnt/c/... itself, so relative paths work).
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)

function hasNativeDocker() {
  const probe = spawnSync('docker', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' })
  return probe.status === 0
}

const useWsl = process.platform === 'win32' && !hasNativeDocker()
const [cmd, cmdArgs] = useWsl ? ['wsl', ['docker', ...args]] : ['docker', args]

const result = spawnSync(cmd, cmdArgs, { stdio: 'inherit' })
process.exit(result.status ?? 1)
