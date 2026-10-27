// node --test .agents/skills/release-check/scripts/
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { analyzeContracts, compareVersions, directionOf, diffNativeDeps, parseDiff, plan, review } from './release-check.mjs'

const CONTRACT = 'app/packages/contracts/src/api/app-status.ts'

/** A unified diff of one file; `lines` carry their own ' ', '+' or '-' prefix. */
const diff = (path, context, lines) =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -1,9 +1,9 @@ ${context}`, ...lines].join('\n')

const levels = (path, context, lines) => analyzeContracts(parseDiff(diff(path, context, lines))).map((finding) => `${finding.level}: ${finding.message}`)

const RESPONSE = 'export interface AppStatusApiResponse {'
const QUERY = 'export interface AppStatusApiQuery {'

describe('поля контракта', () => {
  it('необязательное поле в ответе — совместимо', () => {
    assert.deepEqual(levels(CONTRACT, RESPONSE, [' jsVersion: string | null', '+  extra?: string']), [])
  })

  it('обязательное поле в ответе — тоже совместимо: клиенты лишнее игнорируют', () => {
    assert.deepEqual(levels(CONTRACT, RESPONSE, ['+  extra: string']), [])
  })

  it('удалённое поле ответа ломает старых клиентов', () => {
    const found = levels(CONTRACT, RESPONSE, ['-  storeUrl: string | null'])
    assert.equal(found.length, 1)
    assert.match(found[0], /^BREAKING: .*storeUrl.*удалено/)
  })

  it('удалённое поле запроса — только взгляд: сервер мог его требовать', () => {
    assert.match(levels(CONTRACT, QUERY, ['-  js_version?: string'])[0], /^REVIEW/)
  })

  it('новое обязательное поле запроса ломает, необязательное — нет', () => {
    assert.match(levels(CONTRACT, QUERY, ['+  locale: string'])[0], /^BREAKING: .*locale/)
    assert.deepEqual(levels(CONTRACT, QUERY, ['+  locale?: string']), [])
  })

  it('необязательное поле запроса стало обязательным — ломает; в ответе — нет', () => {
    assert.match(levels(CONTRACT, QUERY, ['-  js_version?: string', '+  js_version: string'])[0], /^BREAKING: .*обязательным/)
    assert.deepEqual(levels(CONTRACT, RESPONSE, ['-  jsVersion?: string', '+  jsVersion: string']), [])
  })

  it('поле ответа стало необязательным — взгляд: старый клиент ждёт значение', () => {
    assert.match(levels(CONTRACT, RESPONSE, ['-  jsVersion: string', '+  jsVersion?: string'])[0], /^REVIEW: .*необязательным/)
  })

  it('смена типа поля — взгляд', () => {
    assert.match(levels(CONTRACT, RESPONSE, ['-  latestVersionCode: number', '+  latestVersionCode: string'])[0], /^REVIEW: .*тип number → string/)
  })

  it('переформатирование без смены смысла ничего не находит', () => {
    assert.deepEqual(levels(CONTRACT, RESPONSE, ['-  jsVersion:   string | null;', '+  jsVersion: string | null,']), [])
  })

  it('комментарии не считаются', () => {
    assert.deepEqual(levels(CONTRACT, RESPONSE, ['-  /** old doc */', '+  /** new doc */']), [])
  })

  it('новый тип целиком — совместимо: у него ещё нет старых клиентов', () => {
    assert.deepEqual(levels(CONTRACT, '', ['+export interface FreshRequest {', '+  id: string', '+  note: string', '+}']), [])
    assert.deepEqual(levels(CONTRACT, '', ['+export enum FreshKind {', "+  A = 'a',", '+}']), [])
  })

  it('удалённый тип целиком даёт одну находку, а не по строке на каждый член', () => {
    const found = levels(CONTRACT, '', ['-export enum Gone {', "-  A = 'a',", "-  B = 'b',", '-}'])
    assert.equal(found.length, 1)
    assert.match(found[0], /^BREAKING: .*Gone/)
  })

  it('закрывающие скобки не считаются содержанием', () => {
    assert.deepEqual(levels(CONTRACT, RESPONSE, ['-}', '+}']), [])
  })

  it('строка, которую правила не узнали, не молчит', () => {
    assert.match(levels(CONTRACT, RESPONSE, ['-  [key: string]: unknown'])[0], /^REVIEW: .*не узнало/)
  })
})

describe('enum, объединения и экспорты', () => {
  const ENUM = 'export enum UpdateAvailability {'

  it('новый член ответного enum — взгляд: строгий разбор отвергнет неизвестное', () => {
    assert.match(levels(CONTRACT, ENUM, ["+  Postponed = 'postponed',"])[0], /^REVIEW: .*Postponed.*строгим разбором/)
  })

  it('удалённый член и изменённое значение ломают', () => {
    assert.match(levels(CONTRACT, ENUM, ["-  Required = 'required',"])[0], /^BREAKING: .*Required.*удалён/)
    assert.match(levels(CONTRACT, ENUM, ["-  Required = 'required',", "+  Required = 'mandatory',"])[0], /^BREAKING: .*значение/)
  })

  it('новый маршрут и новый заголовок — совместимо', () => {
    assert.deepEqual(levels('app/packages/contracts/src/api/paths.ts', 'export enum ApiPath {', ["+  Notes = '/api/notes',"]), [])
    assert.deepEqual(levels('app/packages/contracts/src/api/headers.ts', 'export enum AppHeader {', ["+  Build = 'X-Build',"]), [])
  })

  it('изменённый путь маршрута ломает', () => {
    assert.match(levels('app/packages/contracts/src/api/paths.ts', 'export enum ApiPath {', ["-  AppStatus = '/api/app-status',", "+  AppStatus = '/api/status',"])[0], /^BREAKING/)
  })

  it('убранное значение объединения ломает, добавленное — взгляд', () => {
    const was = "-export type MoodTone = 'neutral' | 'sleepy' | 'angry'"
    assert.match(levels(CONTRACT, '', [was, "+export type MoodTone = 'neutral' | 'sleepy'"])[0], /^BREAKING: .*'angry'/)
    assert.match(levels(CONTRACT, '', [was, "+export type MoodTone = 'neutral' | 'sleepy' | 'angry' | 'calm'"])[0], /^REVIEW: .*'calm'/)
  })

  it('удалённый экспорт ломает', () => {
    assert.match(levels(CONTRACT, '', ['-export interface LegacyThing {', '-  id: string', '-}'])[0], /^BREAKING: .*LegacyThing/)
  })
})

describe('маршруты API', () => {
  const ROUTES = 'app/services/api/src/routes/notes.ts'
  const found = (lines) => analyzeContracts(parseDiff(diff(ROUTES, 'export function notesRoutes', lines))).map((finding) => `${finding.level}: ${finding.message}`)

  it('удалённый или переименованный маршрут ломает', () => {
    assert.match(found(['-  app.get(ApiPath.Notes, auth, (c) => c.json([]))', '+  app.get(ApiPath.NoteList, auth, (c) => c.json([]))'])[0], /^BREAKING: .*ApiPath\.Notes/)
  })

  it('тот же маршрут с другим обработчиком — совместимо', () => {
    assert.deepEqual(found(['-  app.get(ApiPath.Notes, auth, (c) => c.json([]))', '+  app.get(ApiPath.Notes, auth, async (c) => c.json(await list()))']), [])
  })

  it('параметр запроса перестал быть необязательным — взгляд', () => {
    assert.match(found(['-  limit: z.coerce.number().optional(),', '+  limit: z.coerce.number(),'])[0], /^REVIEW: .*limit/)
  })
})

describe('направление типа', () => {
  it('по имени', () => {
    assert.equal(directionOf('AppStatusApiQuery'), 'request')
    assert.equal(directionOf('AppStatusApiResponse'), 'response')
    assert.equal(directionOf('DialogEvent'), 'both')
  })
})

describe('нативная часть и версии', () => {
  const base = { version: '0.1.0', dependencies: { '@capacitor/core': '^8.5.2', react: '^19.0.0' } }
  const POLICY = 'const OTA_MIN_NATIVE_BUILD: Partial<Record<AppPlatform, number>> = {}'
  const BUMPED = 'const OTA_MIN_NATIVE_BUILD: Partial<Record<AppPlatform, number>> = { [AppPlatform.Android]: 15 }'
  const input = (extra) => ({
    diffFiles: [],
    changedPaths: [],
    mobilePackageBefore: base,
    mobilePackageAfter: base,
    policyBefore: POLICY,
    policyAfter: POLICY,
    specMentionsBreaking: false,
    jsBuildNumber: 312,
    ...extra,
  })

  it('нативные зависимости: добавлена, убрана, обновлена; обычные не считаются', () => {
    const after = { dependencies: { '@capacitor/core': '^8.6.0', '@capgo/camera': '^1.0.0', react: '^20.0.0' } }
    assert.deepEqual(diffNativeDeps(base, after), { added: ['@capgo/camera'], removed: [], upgraded: ['@capacitor/core'] })
  })

  it('новая нативная зависимость без OTA_MIN_NATIVE_BUILD — нарушение; с ним — нет', () => {
    const after = { ...base, dependencies: { ...base.dependencies, '@capgo/camera': '^1.0.0' } }
    const bad = review(input({ mobilePackageAfter: after, changedPaths: [`app/apps/mobile/package.json`] }))
    assert.equal(bad.verdict.nativeRelease, true)
    assert.match(bad.failures.join('\n'), /OTA_MIN_NATIVE_BUILD/)
    const good = review(input({ mobilePackageAfter: after, policyAfter: BUMPED, changedPaths: [`app/apps/mobile/package.json`] }))
    assert.deepEqual(good.failures, [])
  })

  it('файлы android и ios, capacitor.config — нативная сборка', () => {
    for (const path of ['app/apps/mobile/android/app/src/main/AndroidManifest.xml', 'app/apps/mobile/ios/App/App/Info.plist', 'app/apps/mobile/capacitor.config.ts']) {
      assert.equal(review(input({ changedPaths: [path] })).verdict.nativeRelease, true, path)
    }
    assert.equal(review(input({ changedPaths: ['app/apps/mobile/src/client/lib/app-update.ts'] })).verdict.nativeRelease, false)
  })

  it('ломающий контракт без пометки BREAKING в OpenSpec — нарушение', () => {
    const diffFiles = parseDiff(diff(CONTRACT, RESPONSE, ['-  storeUrl: string | null']))
    const bad = review(input({ diffFiles, changedPaths: [CONTRACT] }))
    assert.equal(bad.verdict.api, 'BREAKING')
    assert.match(bad.failures.join('\n'), /BREAKING/)
    assert.match(plan(bad).join('\n'), /расширь-и-сузь/)
    assert.deepEqual(review(input({ diffFiles, changedPaths: [CONTRACT], specMentionsBreaking: true })).failures, [])
  })

  it('понижение версии apps/mobile — нарушение, повышение без натива — предупреждение', () => {
    assert.match(review(input({ mobilePackageAfter: { ...base, version: '0.0.9' } })).failures.join('\n'), /понижена/)
    const raised = review(input({ mobilePackageAfter: { ...base, version: '0.2.0' } }))
    assert.deepEqual(raised.failures, [])
    assert.match(raised.warnings.join('\n'), /НЕ изолирует/)
  })

  it('версия пакета JS — версия apps/mobile и число коммитов', () => {
    const result = review(input({ changedPaths: ['app/apps/mobile/src/client/lib/app-update.ts'] }))
    assert.equal(result.verdict.jsVersion, '0.1.0.312')
    assert.equal(result.verdict.jsBundleChanges, true)
  })

  it('номер следующей нативной сборки — на единицу больше последней выпущенной', () => {
    const result = review(input({ changedPaths: ['app/apps/mobile/android/build.gradle'], last: { android: 57, ios: 12 } }))
    assert.deepEqual(result.verdict.nextVersionCode, { android: 58, ios: 13 })
  })

  it('какие образы выкатывать', () => {
    assert.deepEqual(review(input({ changedPaths: ['app/services/api/src/routes/x.ts'] })).verdict.images, ['api'])
    assert.deepEqual(review(input({ changedPaths: [CONTRACT] })).verdict.images, ['api', 'pwa', 'web'])
    assert.deepEqual(review(input({ changedPaths: ['app/apps/mobile/src/client/x.ts'] })).verdict.images, ['api', 'pwa'])
    assert.deepEqual(review(input({ changedPaths: ['app/apps/landing/x.ts'] })).verdict.images, ['landing'])
  })

  it('чужая ветка: HEAD без базового коммита — предупреждение', () => {
    assert.match(review(input({ baseIsAncestor: false })).warnings.join('\n'), /число коммитов/)
  })

  it('реальный release-policy.ts: константа находится', () => {
    const source = readFileSync(fileURLToPath(new URL('../../../../app/services/api/src/lib/release-policy.ts', import.meta.url)), 'utf8')
    const untouched = review(input({ policyBefore: source, policyAfter: source }))
    assert.equal(untouched.policyBumped, false)
    const bumped = source.replace(/(const OTA_MIN_NATIVE_BUILD[^=]*=\s*)\{\}/, '$1{ [AppPlatform.Android]: 15 }')
    assert.notEqual(bumped, source, 'константа должна быть пустой в main, иначе тест надо обновить')
    assert.equal(review(input({ policyBefore: source, policyAfter: bumped })).policyBumped, true)
  })
})

describe('сравнение версий', () => {
  it('сегментами и числами, как на сервере', () => {
    assert.equal(compareVersions('0.1.0.10', '0.1.0.9'), 1)
    assert.equal(compareVersions('1.2', '1.2.0'), 0)
    assert.equal(compareVersions('0.1.0', '0.1.0.1'), -1)
  })
})
