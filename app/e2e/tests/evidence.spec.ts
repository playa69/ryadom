import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '../support/fixtures'
import { evidenceFile, step, type EvidenceStep } from '../support/evidence'

/**
 * The fixture that takes a screenshot per step (support/evidence.ts) works on both projects. Run alone it writes to
 * a temporary folder; under `pnpm evidence <TASK> evidence` it writes the real pictures of that task, which makes it
 * the shortest way to try the whole chain on a stand.
 */

test('step снимает кадр на каждом проекте, пишет манифест и индекс', async ({ page }, testInfo) => {
  const own = !process.env.EVIDENCE
  const scratch = own ? mkdtempSync(join(tmpdir(), 'ryadom-evidence-')) : null
  if (scratch) {
    process.env.EVIDENCE = 'selftest'
    process.env.EVIDENCE_DIR = scratch
  }
  const task = process.env.EVIDENCE as string
  try {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('рядом')
    await step(page, 'landing-home', 'Главная страница сайта: заголовок и призыв открыть приложение')

    await page.goto('/download')
    await expect(page.getByRole('heading', { name: 'Установить из браузера' })).toBeVisible()
    await step(page, 'landing-download', 'Страница «Скачать»: как установить приложение')

    const manifest = JSON.parse(readFileSync(evidenceFile(task, 'manifest.json'), 'utf8')) as {
      steps: EvidenceStep[]
    }
    const mine = manifest.steps.filter(
      (s) => s.project === testInfo.project.name && s.spec === 'evidence.spec.ts',
    )
    expect(mine.map((s) => s.slug)).toEqual(['landing-home', 'landing-download'])
    for (const entry of mine) {
      expect(entry.file).toMatch(new RegExp(`^${testInfo.project.name}/\\d\\d-${entry.slug}\\.png$`))
      expect(statSync(evidenceFile(task, entry.file)).size, entry.file).toBeGreaterThan(5_000)
    }
    expect(readFileSync(evidenceFile(task, 'index.md'), 'utf8')).toContain('Страница «Скачать»')
  } finally {
    if (scratch) {
      delete process.env.EVIDENCE
      delete process.env.EVIDENCE_DIR
      rmSync(scratch, { recursive: true, force: true })
    }
  }
})
