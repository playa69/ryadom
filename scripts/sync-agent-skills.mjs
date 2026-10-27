#!/usr/bin/env node
// Copies the agent skills from .agents/skills (read by Codex and Kimi Code) into .claude/skills, because
// Claude Code reads only .claude/skills. Symlinks would do the same without copies, but git on Windows
// checks them out as plain text files unless core.symlinks and Developer Mode are on, and Claude then
// sees nothing.
//
//   node scripts/sync-agent-skills.mjs          write the copies
//   node scripts/sync-agent-skills.mjs --check  exit 1 if the copies differ from the source
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, '.agents', 'skills')
const target = join(root, '.claude', 'skills')
const readmeName = 'README.md'
const readme = `# Копии скиллов для Claude Code

Сгенерировано \`node scripts/sync-agent-skills.mjs\` из \`.agents/skills/\`. Здесь не правь: правка — в
\`.agents/skills/\`, затем скрипт, и копии в том же коммите. Codex и Kimi читают \`.agents/skills/\` сами.
`
const check = process.argv.includes('--check')

// A skill is a directory; hidden entries at the top level (tool markers) are not skills.
const skillNames = (dir) =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort() : []

const filesUnder = (dir) =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).replaceAll('\\', '/'))
    .sort()

// With core.autocrlf=true the working copies on Windows carry CRLF while git stores LF: compare the text, not the bytes.
const sameText = (a, b) => readFileSync(a, 'utf8').replaceAll('\r\n', '\n') === readFileSync(b, 'utf8').replaceAll('\r\n', '\n')

const differences = () => {
  const found = []
  const wanted = skillNames(source)
  const present = skillNames(target)
  for (const name of present.filter((n) => !wanted.includes(n))) found.push(`лишний скилл: .claude/skills/${name}`)
  for (const name of wanted) {
    if (!present.includes(name)) {
      found.push(`нет копии: .claude/skills/${name}`)
      continue
    }
    const from = filesUnder(join(source, name))
    const to = filesUnder(join(target, name))
    for (const file of to.filter((f) => !from.includes(f))) found.push(`лишний файл: .claude/skills/${name}/${file}`)
    for (const file of from) {
      if (!to.includes(file)) found.push(`нет файла: .claude/skills/${name}/${file}`)
      else if (!sameText(join(source, name, file), join(target, name, file))) found.push(`отличается: .claude/skills/${name}/${file}`)
    }
  }
  const readmePath = join(target, readmeName)
  if (!existsSync(readmePath) || readFileSync(readmePath, 'utf8').replaceAll('\r\n', '\n') !== readme) found.push(`нет или отличается: .claude/skills/${readmeName}`)
  return found
}

if (check) {
  const found = differences()
  if (found.length > 0) {
    console.error(`Копии скиллов для Claude разошлись с .agents/skills — запусти node scripts/sync-agent-skills.mjs:\n${found.map((f) => `  ${f}`).join('\n')}`)
    process.exit(1)
  }
  console.log('Копии скиллов для Claude совпадают с .agents/skills.')
  process.exit(0)
}

mkdirSync(target, { recursive: true })
for (const name of skillNames(target)) rmSync(join(target, name), { recursive: true, force: true })
for (const name of skillNames(source)) {
  cpSync(join(source, name), join(target, name), { recursive: true })
  // Keep the executable bit of the skill scripts where the file system has one.
  for (const file of filesUnder(join(source, name))) chmodSync(join(target, name, file), statSync(join(source, name, file)).mode)
}
writeFileSync(join(target, readmeName), readme)
console.log(`Скопировано в .claude/skills: ${skillNames(source).join(', ')}`)
