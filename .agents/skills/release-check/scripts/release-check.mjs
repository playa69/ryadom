#!/usr/bin/env node
// Release check for «Рядом»: reads the diff against a base ref and says what it does to old clients -
// is the API contract still compatible, does the change need a native build, what the JS bundle
// version will be, and which integrity rules the diff already breaks.
//
//   node .agents/skills/release-check/scripts/release-check.mjs [--base origin/main] [--head <commit>]
//        [--json] [--last-android <versionCode>] [--last-ios <build>]
//
// By default the diff is the working tree against the merge base with --base; --head <commit> checks
// committed state only, which is what build.sh uses before it builds an image from that commit.
//
// Exit code 1 means a rule is broken (a breaking contract change nobody wrote down, a new native
// plugin without OTA_MIN_NATIVE_BUILD, a lowered mobile version); the findings only tell what to look at.
// The contract check is a heuristic over the diff text, not a type checker: it sees shapes (fields,
// enum members, routes), never semantics (status codes, defaults, ordering) - SKILL.md lists those.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const NATIVE_PACKAGE = /^(@capacitor\/|@capacitor-community\/|@capgo\/|@aparajita\/|capacitor-)/
const MOBILE = 'app/apps/mobile/'
const CONTRACTS = 'app/packages/contracts/src/'
const API_ROUTES = 'app/services/api/src/routes/'

const COMMENT = /^\s*(\/\/|\/\*|\*)/
const PUNCTUATION = /^\s*[{}()[\]]+[;,]?\s*$/
const DECL = /^export\s+(?:declare\s+)?(const\s+enum|enum|interface|type|const|function|class)\s+([\w$]+)/
const FIELD = /^\s*(?:readonly\s+)?(['"]?[\w$-]+['"]?)(\?)?:\s*(.+?)\s*[;,]?\s*$/
const ENUM_MEMBER = /^\s*([\w$]+)\s*=\s*(.+?)\s*,?\s*$/
const ROUTE = /\bapp\.(?:get|post|put|patch|delete|all)\(\s*([^,]+?)\s*,/
const normalize = (text) => text.replace(/\s+/g, ' ').replace(/[;,]$/, '').trim()

// ─── diff ────────────────────────────────────────────────────────────────────

/** A unified diff as `[{ path, deleted, added: [{ text, line, decl }], removed: [...] }]`; `decl` is the enclosing top-level declaration. */
export function parseDiff(text) {
  const files = []
  let file = null
  let oldPath = ''
  let line = 0
  let decl = null
  let header = false
  const track = (body) => {
    const match = DECL.exec(body)
    if (match) decl = { kind: match[1].replace('const enum', 'enum'), name: match[2] }
    else if (body === '}') decl = null
  }
  for (const raw of text.split('\n')) {
    const row = raw.replace(/\r$/, '')
    if (row.startsWith('diff --git ')) {
      file = null
      header = true
    } else if (header && row.startsWith('--- ')) {
      oldPath = row.slice(4).replace(/^a\//, '')
    } else if (header && row.startsWith('+++ ')) {
      const path = row.slice(4)
      file = { path: path === '/dev/null' ? oldPath : path.replace(/^b\//, ''), deleted: path === '/dev/null', added: [], removed: [] }
      files.push(file)
    } else if (row.startsWith('@@')) {
      header = false
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(row)
      line = hunk ? Number(hunk[1]) : 0
      decl = null
      if (hunk) track(hunk[2])
    } else if (file && row.startsWith('+')) {
      track(row.slice(1))
      file.added.push({ text: row.slice(1), line: line++, decl })
    } else if (file && row.startsWith('-')) {
      track(row.slice(1))
      file.removed.push({ text: row.slice(1), line, decl })
    } else if (file && row.startsWith(' ')) {
      track(row.slice(1))
      line++
    }
  }
  return files
}

// ─── contract compatibility ──────────────────────────────────────────────────

/** Who produces the type: a request is sent by old clients, a response is read by them; the rest is both. */
export function directionOf(name) {
  if (/(Query|Request|Body|Payload|Input)$/.test(name)) return 'request'
  if (/(Response|Result)$/.test(name)) return 'response'
  return 'both'
}

const literals = (text) => new Set(text.match(/'[^']*'|"[^"]*"/g) ?? [])

/** Findings for one file under `packages/contracts/src`. */
export function analyzeContractFile(file) {
  const findings = []
  const consumed = new Set()
  const say = (level, item, message) => findings.push({ level, file: file.path, line: item.line, message })
  const slots = new Map()
  const slotOf = (decl) => {
    const key = `${decl.kind}:${decl.name}`
    if (!slots.has(key)) slots.set(key, { decl, removed: new Map(), added: new Map() })
    return slots.get(key)
  }
  const declared = { removed: new Map(), added: new Map() }

  for (const side of ['removed', 'added']) {
    for (const item of file[side]) {
      const text = item.text
      if (!text.trim() || COMMENT.test(text) || PUNCTUATION.test(text)) {
        consumed.add(item)
        continue
      }
      const top = DECL.exec(text)
      if (top) {
        declared[side].set(top[2], { item, kind: top[1], text: normalize(text) })
        consumed.add(item)
        continue
      }
      if (!item.decl) continue
      if (item.decl.kind === 'enum') {
        const member = ENUM_MEMBER.exec(text)
        if (member) slotOf(item.decl)[side].set(member[1], { item, value: normalize(member[2]) })
      } else if (item.decl.kind === 'interface' || item.decl.kind === 'type') {
        const field = FIELD.exec(text)
        if (field) slotOf(item.decl)[side].set(field[1], { item, optional: Boolean(field[2]), type: normalize(field[3]) })
      }
    }
  }

  // Whole declarations.
  for (const [name, gone] of declared.removed) {
    const now = declared.added.get(name)
    if (!now) {
      say('BREAKING', gone.item, `экспорт ${name} удалён или переименован`)
      continue
    }
    const before = /^export\s+type\s+[\w$]+\s*=\s*(.+)$/.exec(gone.text)
    const after = /^export\s+type\s+[\w$]+\s*=\s*(.+)$/.exec(now.text)
    if (before && after) {
      const was = literals(before[1])
      const is = literals(after[1])
      for (const value of was) if (!is.has(value)) say('BREAKING', gone.item, `${name}: значение ${value} убрано`)
      for (const value of is) if (!was.has(value) && directionOf(name) !== 'request') say('REVIEW', now.item, `${name}: добавлено значение ${value} — старые клиенты со строгим разбором его отвергнут`)
    }
  }

  // Fields and enum members, by declaration.
  for (const { decl, removed, added } of slots.values()) {
    const direction = directionOf(decl.name)
    const isNew = declared.added.has(decl.name) && !declared.removed.has(decl.name)
    const isGone = declared.removed.has(decl.name) && !declared.added.has(decl.name)
    // A type that appears in this diff has no old clients, and one that disappears is reported once, as an export.
    if (isNew || isGone) {
      for (const item of [...removed.values(), ...added.values()]) consumed.add(item.item)
      continue
    }
    if (decl.kind === 'enum') {
      for (const [name, was] of removed) {
        const now = added.get(name)
        consumed.add(was.item)
        if (!now) say('BREAKING', was.item, `${decl.name}.${name} удалён`)
        else if (now.value !== was.value) say('BREAKING', was.item, `${decl.name}.${name}: значение ${was.value} → ${now.value}`)
        if (now) consumed.add(now.item)
      }
      for (const [name, now] of added) {
        consumed.add(now.item)
        if (removed.has(name) || direction === 'request' || /(Path|Header)s?$/.test(decl.name)) continue
        say('REVIEW', now.item, `${decl.name}.${name} добавлен — старые клиенты со строгим разбором (как parseAppStatus в app-update.ts) отвергнут неизвестное значение`)
      }
      continue
    }
    for (const [name, was] of removed) {
      consumed.add(was.item)
      const now = added.get(name)
      if (!now) {
        say(direction === 'request' ? 'REVIEW' : 'BREAKING', was.item, `поле ${decl.name}.${name} удалено`)
        continue
      }
      consumed.add(now.item)
      if (was.optional && !now.optional && direction !== 'response') {
        say(direction === 'request' ? 'BREAKING' : 'REVIEW', now.item, `поле ${decl.name}.${name} стало обязательным: старые клиенты его не шлют`)
      } else if (!was.optional && now.optional && direction !== 'request') {
        say('REVIEW', now.item, `поле ${decl.name}.${name} стало необязательным: старый клиент может ждать значение`)
      }
      if (was.type !== now.type) say('REVIEW', now.item, `поле ${decl.name}.${name}: тип ${was.type} → ${now.type}`)
    }
    for (const [name, now] of added) {
      consumed.add(now.item)
      if (removed.has(name) || now.optional || direction === 'response') continue
      say(direction === 'request' ? 'BREAKING' : 'REVIEW', now.item, `новое обязательное поле ${decl.name}.${name}: старые клиенты его не шлют`)
    }
  }

  for (const item of file.removed) {
    if (!consumed.has(item)) say('REVIEW', item, `строка контракта изменена, правило её не узнало: ${normalize(item.text)}`)
  }
  return findings
}

/** Findings for one file under `services/api/src/routes`: removed routes and request fields that became required. */
export function analyzeRouteFile(file) {
  const findings = []
  const routes = (items) => new Map(items.map((item) => [ROUTE.exec(item.text)?.[1], item]).filter(([expr]) => expr))
  const now = routes(file.added)
  for (const [expr, item] of routes(file.removed)) {
    if (!now.has(expr)) findings.push({ level: 'BREAKING', file: file.path, line: item.line, message: `маршрут ${expr} удалён или переименован` })
  }
  for (const item of file.removed) {
    const key = /^\s*([\w$]+):.*\.optional\(\)/.exec(item.text)?.[1]
    if (!key) continue
    const same = file.added.find((other) => new RegExp(`^\\s*${key}:`).test(other.text))
    if (same && !same.text.includes('.optional()')) {
      findings.push({ level: 'REVIEW', file: file.path, line: same.line, message: `параметр ${key} перестал быть необязательным: старые клиенты его не шлют` })
    }
  }
  return findings
}

export function analyzeContracts(diffFiles) {
  const found = diffFiles.flatMap((file) => {
    if (file.path.startsWith(CONTRACTS)) return analyzeContractFile(file)
    if (file.path.startsWith(API_ROUTES)) return analyzeRouteFile(file)
    return []
  })
  const seen = new Set()
  return found.filter((finding) => {
    const key = `${finding.file}:${finding.line}:${finding.message}`
    return seen.has(key) ? false : seen.add(key)
  })
}

// ─── native and versions ─────────────────────────────────────────────────────

const nativeDeps = (pkg) =>
  Object.fromEntries(Object.entries({ ...pkg?.dependencies, ...pkg?.devDependencies }).filter(([name]) => NATIVE_PACKAGE.test(name)))

export function diffNativeDeps(before, after) {
  const was = nativeDeps(before)
  const is = nativeDeps(after)
  return {
    added: Object.keys(is).filter((name) => !(name in was)),
    removed: Object.keys(was).filter((name) => !(name in is)),
    upgraded: Object.keys(is).filter((name) => name in was && was[name] !== is[name]),
  }
}

const otaMinNative = (source) => /OTA_MIN_NATIVE_BUILD[^=]*=\s*\{([^}]*)\}/s.exec(source ?? '')?.[1].replace(/\s+/g, ' ').trim() ?? null

/** The same comparison the server makes: segment by segment, as numbers. */
export function compareVersions(a, b) {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

const startsWithAny = (path, prefixes) => prefixes.some((prefix) => path.startsWith(prefix))

/** The decision. Pure: everything it needs is passed in, so tests can feed it synthetic diffs. */
export function review(input) {
  const { diffFiles, changedPaths, mobilePackageBefore, mobilePackageAfter, policyBefore, policyAfter, specMentionsBreaking, jsBuildNumber, last = {}, baseIsAncestor = true } = input
  const touches = (...prefixes) => changedPaths.some((path) => startsWithAny(path, prefixes))
  const findings = analyzeContracts(diffFiles)
  const breaking = findings.filter((finding) => finding.level === 'BREAKING')
  const deps = diffNativeDeps(mobilePackageBefore, mobilePackageAfter)
  const nativeFiles = changedPaths.filter((path) => startsWithAny(path, [`${MOBILE}android/`, `${MOBILE}ios/`, `${MOBILE}capacitor.config.ts`]))
  const nativeRelease = nativeFiles.length > 0 || deps.added.length > 0 || deps.removed.length > 0 || deps.upgraded.length > 0
  const policyBumped = otaMinNative(policyBefore) !== otaMinNative(policyAfter)

  const jsChanged = touches(MOBILE, 'app/packages/client-core/', 'app/packages/contracts/', 'app/packages/design/', 'app/packages/analytics/', 'app/packages/self-check/')
  const images = [
    ['api', touches('app/services/api/', CONTRACTS, 'app/packages/core/', 'app/packages/db/') || jsChanged],
    ['pwa', touches(MOBILE, 'app/packages/client-core/', 'app/packages/contracts/', 'app/packages/design/', 'app/packages/analytics/', 'app/packages/self-check/')],
    ['web', touches('app/apps/web/', 'app/packages/client-core/', 'app/packages/contracts/', 'app/packages/ui/', 'app/packages/self-check/')],
    ['landing', touches('app/apps/landing/')],
    ['admin', touches('app/apps/admin/')],
    ['migrate', touches('app/packages/db/')],
  ]
    .filter(([, needed]) => needed)
    .map(([name]) => name)

  const versionBefore = mobilePackageBefore?.version
  const versionAfter = mobilePackageAfter?.version
  const failures = []
  if (breaking.length > 0 && !specMentionsBreaking) {
    failures.push('Контракт сломан, а в OpenSpec change (proposal.md или design.md в этом диффе) нет пометки BREAKING и плана совместимости.')
  }
  if (deps.added.length > 0 && !policyBumped) {
    failures.push(`Новая нативная зависимость (${deps.added.join(', ')}), а OTA_MIN_NATIVE_BUILD в release-policy.ts не тронут: пакет с ней получат сборки без этого плагина.`)
  }
  if (versionBefore && versionAfter && compareVersions(versionAfter, versionBefore) < 0) {
    failures.push(`Версия apps/mobile понижена ${versionBefore} → ${versionAfter}: все клиенты окажутся «новее сервера» и откатятся на пакет.`)
  }
  const warnings = []
  if (!baseIsAncestor) warnings.push('HEAD не содержит базовый коммит: номер пакета (число коммитов) может оказаться меньше выкаченного — собирай образ api из коммита, в который вошло всё выкаченное.')
  if (versionBefore && versionAfter && compareVersions(versionAfter, versionBefore) > 0 && !policyBumped && !nativeRelease) {
    warnings.push(`Версия apps/mobile повышена ${versionBefore} → ${versionAfter} без нативной сборки: это НЕ изолирует старые нативные сборки от нового пакета, изолирует только OTA_MIN_NATIVE_BUILD.`)
  }
  if (deps.upgraded.length > 0) warnings.push(`Обновлены нативные зависимости (${deps.upgraded.join(', ')}): если пакет использует их новое API, нужна нативная сборка и OTA_MIN_NATIVE_BUILD.`)

  const jsVersion = versionAfter ? `${versionAfter}.${jsBuildNumber ?? 0}` : null
  const verdict = {
    api: breaking.length > 0 ? 'BREAKING' : findings.some((finding) => finding.level === 'REVIEW') ? 'REVIEW' : 'COMPATIBLE',
    nativeRelease,
    jsBundleChanges: jsChanged,
    jsVersion,
    images,
    nextVersionCode: Object.fromEntries(Object.entries(last).map(([platform, value]) => [platform, value + 1])),
  }
  return { verdict, findings, failures, warnings, nativeFiles, nativeDeps: deps, policyBumped }
}

// ─── report ──────────────────────────────────────────────────────────────────

export function plan(result) {
  const { verdict, nativeDeps: deps } = result
  const lines = []
  if (verdict.jsBundleChanges) {
    lines.push(`JS: пакет соберётся в образе api сам, версия ${verdict.jsVersion ?? '?'} (номер — число коммитов HEAD, вручную ничего не бампится).`)
    lines.push('JS срочный или критичный: после выката MOBILE_JS_MIN_VERSION = версия пакета образа (жёстко); обычное — ничего (тихо).')
  }
  if (verdict.nativeRelease) {
    lines.push('Натив: нужна новая нативная сборка. versionName = версия apps/mobile; versionCode (iOS — номер сборки) строго больше последнего выпущенного.')
    if (Object.keys(verdict.nextVersionCode).length > 0) lines.push(`  минимум для следующей сборки: ${JSON.stringify(verdict.nextVersionCode)}`)
    else lines.push('  последний выпущенный номер скрипту неизвестен: узнай у администратора или передай --last-android N --last-ios N.')
    if (deps.added.length > 0) lines.push('  OTA_MIN_NATIVE_BUILD для платформ = versionCode этой сборки, в том же коммите, что и зависимость.')
    lines.push('  порядок: сборка → публикация в магазине → MOBILE_*_LATEST_VERSION_CODE (мягко) → позже MOBILE_*_MIN_VERSION_CODE (жёстко), только когда LATEST ≥ MIN.')
  }
  if (verdict.api === 'BREAKING') {
    lines.push('Контракт сломан. Либо расширь-и-сузь: выкат 1 — сервер понимает старое и новое, клиенты переходят (web/PWA — образом, JS — пакетом, нативные — сборкой), выкат 2 — убрать старое, когда старых клиентов нет.')
    lines.push('Либо жёстко: новая нативная сборка в магазинах → выкат ломающего API вместе с MOBILE_*_MIN_VERSION_CODE = её номер; web/PWA выкатываются тем же шагом.')
  }
  if (verdict.images.length > 0) lines.push(`Образы к выкату: ${verdict.images.join(', ')}.`)
  return lines
}

export function render(result) {
  const { verdict, findings, failures, warnings } = result
  const out = []
  out.push('== Совместимость API ==')
  out.push(`вердикт: ${{ BREAKING: 'ЛОМАЮЩЕЕ', REVIEW: 'нужен взгляд', COMPATIBLE: 'совместимо (по форме)' }[verdict.api]}`)
  for (const finding of findings) out.push(`  [${finding.level}] ${finding.file}:${finding.line}  ${finding.message}`)
  out.push('')
  out.push('== Версии ==')
  out.push(`нативная сборка: ${verdict.nativeRelease ? 'ТРЕБУЕТСЯ' : 'не требуется'}`)
  out.push(`пакет JS: ${verdict.jsBundleChanges ? `меняется, версия ${verdict.jsVersion ?? '?'}` : 'не меняется'}`)
  for (const line of plan(result)) out.push(`  - ${line}`)
  out.push('')
  out.push('== Целостность ==')
  if (failures.length === 0) out.push('нарушений правил нет')
  for (const failure of failures) out.push(`  [НАРУШЕНИЕ] ${failure}`)
  for (const warning of warnings) out.push(`  [ВНИМАНИЕ] ${warning}`)
  out.push('')
  out.push('Скрипт видит формы (поля, члены enum, маршруты), но не смысл: статусы и коды ошибок, умолчания, порядок сообщений WebSocket, права — по списку в SKILL.md.')
  return out.join('\n')
}

// ─── git ─────────────────────────────────────────────────────────────────────

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const git = (...args) => execFileSync('git', ['-C', root, '-c', 'core.quotepath=off', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
const tryGit = (...args) => {
  try {
    return git(...args)
  } catch {
    return null
  }
}

/**
 * Without `head` the diff is the working tree against the merge base (what a developer is about to
 * hand in, uncommitted files included); with `head` it is committed state only - what an image built
 * from that commit would carry, which is what the deploy gate asks about.
 */
function collect(base, head, last) {
  const tip = head ?? 'HEAD'
  const mergeBase = git('merge-base', base, tip).trim()
  const changed = git('diff', '--name-only', '--no-renames', mergeBase, ...(head ? [head] : [])).split('\n').filter(Boolean)
  const untracked = head ? [] : git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean)
  const changedPaths = [...new Set([...changed, ...untracked])]
  const baseFile = (path) => tryGit('show', `${mergeBase}:${path}`)
  const json = (text) => (text ? JSON.parse(text) : null)
  const worktree = (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null)
  const afterFile = (path) => (head ? tryGit('show', `${head}:${path}`) : worktree(path))
  const specMentionsBreaking = changedPaths
    .filter((path) => /^openspec\/changes\/[^/]+\/(proposal|design)\.md$/.test(path))
    .some((path) => /BREAKING/.test(afterFile(path) ?? ''))
  const policyPath = 'app/services/api/src/lib/release-policy.ts'
  return {
    diffFiles: parseDiff(git('diff', '--no-color', '--no-renames', '-U3', mergeBase, ...(head ? [head] : []))),
    changedPaths,
    mobilePackageBefore: json(baseFile(`${MOBILE}package.json`)),
    mobilePackageAfter: json(afterFile(`${MOBILE}package.json`)),
    policyBefore: baseFile(policyPath),
    policyAfter: afterFile(policyPath),
    specMentionsBreaking,
    jsBuildNumber: Number(git('rev-list', '--count', tip).trim()),
    last,
    baseIsAncestor: tryGit('merge-base', '--is-ancestor', base, tip) !== null,
  }
}

function main() {
  const args = process.argv.slice(2)
  const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)
  if (args.includes('--help')) {
    console.log('usage: release-check.mjs [--base origin/main] [--head <commit>] [--json] [--last-android N] [--last-ios N]')
    return
  }
  const last = {}
  if (value('--last-android')) last.android = Number(value('--last-android'))
  if (value('--last-ios')) last.ios = Number(value('--last-ios'))
  let result
  try {
    result = review(collect(value('--base') ?? 'origin/main', value('--head'), last))
  } catch (error) {
    // Exit 2 is "could not check", not "checked and failed": an unknown ref or a missing fetch must not look like a verdict.
    const detail = String(error.stderr || error.message).trim().split('\n')[0]
    console.error(`release-check: не удалось прочитать git (${detail}). Проверь --base и --head; origin/main нужно подтянуть: git fetch origin main.`)
    process.exitCode = 2
    return
  }
  console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : render(result))
  process.exitCode = result.failures.length > 0 ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
