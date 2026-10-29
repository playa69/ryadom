import { test, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STAND } from '../playwright.config'
import { findGlitches } from '../scripts/shots/glitches.mjs'

/**
 * Screenshots as proof that a scenario works, one per step: `await step(page, 'diary-marked', 'Отметка сохранена')`
 * after the `expect` that shows the step happened. Nothing happens unless EVIDENCE=<TASK> is set (`pnpm evidence
 * <TASK> [specs]` sets it), so the calls stay in the specs for good.
 *
 * Files: e2e/evidence/<TASK>/<project>/<NN>-<slug>.png (project is desktop or mobile), manifest.json and an
 * index.md with the captions, the branch, the commit and the stand. The folder is not in git: the pictures go to
 * the task report as attachments. One picture per THEN of the OpenSpec scenario, three to eight steps in all.
 *
 * The picture is the visible window at CSS pixels, with animations stopped, the caret hidden and every bare date
 * or time masked: the same step must look the same on the next run. Before it is taken the page is checked for
 * layout glitches (scripts/shots/glitches.mjs); they are written to the manifest and the index, and fail the
 * step only with EVIDENCE_STRICT=1.
 */

const e2eRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const MASK_COLOR = '#8c8c8c'

const MONTHS = 'января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря'

export interface StepOptions {
  /** Further regions to hide, e.g. a name the test generated. */
  mask?: Locator[]
  /** Keep dates and times as they are, when the date itself is what the step shows. */
  keepDates?: boolean
  /** The whole page instead of the window. */
  fullPage?: boolean
}

export interface EvidenceStep {
  n: number
  project: string
  slug: string
  caption: string
  /** Path from the task folder, with forward slashes. */
  file: string
  /** The window the picture shows, width×height in CSS pixels. */
  viewport: string
  spec: string
  test: string
  glitches: string[]
}

interface Manifest {
  task: string
  branch: string | null
  commit: string | null
  stand: { id: string; slot: number; web: string; pwa: string }
  generatedAt: string
  steps: EvidenceStep[]
}

/** The folder of the current task. EVIDENCE_DIR moves it (the fixture's own spec writes to a temporary one). */
function taskDir(task: string): string {
  return process.env.EVIDENCE_DIR ?? join(e2eRoot, 'evidence', task)
}

function git(...args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', e2eRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

function readManifest(dir: string, task: string): Manifest {
  try {
    return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest
  } catch {
    return {
      task,
      branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
      commit: git('rev-parse', '--short', 'HEAD'),
      stand: { id: STAND.id, slot: STAND.slot, web: STAND.urls.e2e.web, pwa: STAND.urls.e2e.pwa },
      generatedAt: new Date().toISOString(),
      steps: [],
    }
  }
}

function writeAtomic(file: string, text: string): void {
  const temporary = `${file}.tmp`
  writeFileSync(temporary, text)
  renameSync(temporary, file)
}

function indexOf(manifest: Manifest): string {
  const lines = [
    `# Доказательства: ${manifest.task}`,
    '',
    `- Ветка: \`${manifest.branch ?? 'неизвестна'}\``,
    `- Коммит: \`${manifest.commit ?? 'неизвестен'}\``,
    `- Стенд: \`${manifest.stand.id}\`, слот ${manifest.stand.slot} (веб-приложение ${manifest.stand.web}, PWA ${manifest.stand.pwa})`,
    `- Снято: ${manifest.generatedAt.slice(0, 16).replace('T', ' ')} UTC`,
    '- Даты и время на снимках закрашены серым: снимок одного шага должен совпадать от прогона к прогону.',
  ]
  const projects = [...new Set(manifest.steps.map((step) => step.project))]
  for (const project of projects) {
    const steps = manifest.steps.filter((s) => s.project === project)
    lines.push('', `## ${project} (${steps[0]?.viewport})`)
    let lastTest = ''
    for (const step of steps) {
      if (step.test !== lastTest) {
        lines.push('', `Сценарий: ${step.spec} › ${step.test}`)
        lastTest = step.test
      }
      lines.push(
        '',
        `### ${String(step.n).padStart(2, '0')}. ${step.caption}`,
        '',
        `![${step.slug}](${step.file})`,
      )
      if (step.glitches.length) lines.push('', `Замечания по вёрстке: ${step.glitches.join('; ')}`)
    }
  }
  return `${lines.join('\n')}\n`
}

/** Test and retry already written in this process: a retry of a test replaces its earlier pictures instead of adding to them. */
const started = new Set<string>()

/** Regions that hold a bare date or time (the text of the element is nothing else), where a rerun would differ. */
function dateRegions(page: Page): Locator[] {
  const whole = (pattern: string) => new RegExp(`^\\s*(${pattern})\\s*$`, 'i')
  return [
    page.locator('time, [datetime], [data-evidence-mask]'),
    page.getByText(whole('\\d{1,2}:\\d{2}(:\\d{2})?')),
    page.getByText(whole('\\d{1,2}[./]\\d{1,2}([./]\\d{2,4})?')),
    page.getByText(whole(`\\d{1,2} (${MONTHS})( \\d{4})?`)),
  ]
}

/**
 * Takes the picture of the current step. Call it after the `expect` that shows the step happened. `slug` is the
 * file name part (lower case latin, digits, dashes), `caption` says in Russian what the person sees.
 */
export async function step(
  page: Page,
  slug: string,
  caption: string,
  options: StepOptions = {},
): Promise<void> {
  const task = process.env.EVIDENCE
  if (!task) return
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug))
    throw new Error(`step: slug "${slug}" must be lower case latin letters, digits and dashes`)
  const info = test.info()
  const project = info.project.name
  const dir = taskDir(task)
  mkdirSync(join(dir, project), { recursive: true })
  const manifest = readManifest(dir, task)

  // titlePath starts with the file (older versions put the project before it): keep only the describe and test titles.
  const spec = basename(info.file)
  const testTitle = info.titlePath.filter((part) => part && part !== project && part !== spec).join(' › ')
  const key = `${project}|${info.file}|${testTitle}|${info.retry}`
  if (!started.has(key)) {
    started.add(key)
    for (const old of manifest.steps.filter(
      (s) => s.project === project && s.spec === spec && s.test === testTitle,
    ))
      rmSync(join(dir, old.file), { force: true })
    manifest.steps = manifest.steps.filter(
      (s) => !(s.project === project && s.spec === spec && s.test === testTitle),
    )
  }

  await page.evaluate(() => document.fonts.ready)
  const glitches = (await findGlitches(page, { fullPage: options.fullPage ?? false })) as {
    kind: string
    text: string
  }[]
  const notes = glitches.map((glitch) => `${glitch.kind}: ${glitch.text}`)

  const n = Math.max(0, ...manifest.steps.filter((s) => s.project === project).map((s) => s.n)) + 1
  const file = `${project}/${String(n).padStart(2, '0')}-${slug}.png`
  const mask = [...(options.keepDates ? [] : dateRegions(page)), ...(options.mask ?? [])]
  await page.screenshot({
    path: join(dir, file),
    scale: 'css',
    animations: 'disabled',
    caret: 'hide',
    fullPage: options.fullPage ?? false,
    mask,
    maskColor: MASK_COLOR,
  })

  const size = page.viewportSize()
  const viewport = size ? `${size.width}×${size.height}` : 'unknown'
  manifest.steps.push({ n, project, slug, caption, file, viewport, spec, test: testTitle, glitches: notes })
  manifest.generatedAt = new Date().toISOString()
  writeAtomic(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeAtomic(join(dir, 'index.md'), indexOf(manifest))

  if (notes.length) {
    info.annotations.push({ type: 'evidence-glitch', description: `${slug}: ${notes.join('; ')}` })
    if (process.env.EVIDENCE_STRICT === '1')
      throw new Error(`step "${slug}": layout glitches: ${notes.join('; ')}`)
  }
}

/** For the specs that check the fixture itself. */
export const evidenceFile = (task: string, relative: string): string => join(taskDir(task), relative)
export const evidenceExists = (task: string, relative: string): boolean =>
  existsSync(evidenceFile(task, relative))
