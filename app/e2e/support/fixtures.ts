import { test as base, type BrowserContext, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installMicrophone, installSpeechStub } from './speech'

/**
 * Screenshots go to `e2e/screenshots/` (not in git): the test run's own pictures, kept apart from the
 * curated set of every app's current screens in the repository's `screenshots/`.
 */
const e2eRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SCREENSHOT_DIR = join(e2eRoot, 'screenshots')

export type Shot = (page: Page, name: string, options?: { fullPage?: boolean }) => Promise<void>

/**
 * A client address of its own for every test. The API limits sign-in and code entry per IP (10 a
 * minute) and the whole suite comes from 127.0.0.1: once both clients' account scenarios run back to
 * back in both projects, the shared bucket runs dry and a later sign-in is refused with 429. The API
 * reads the address from X-Forwarded-For, as it does behind the ingress.
 */
function addressFor(key: string): string {
  const [a, b, c] = createHash('sha1').update(key).digest()
  return `10.${a}.${b}.${c}`
}

/**
 * A route, not `extraHTTPHeaders`: those count as set by the page, so the web app's cross-origin
 * calls to the API would be preflighted and refused (the API does not allow this header).
 */
async function prepareContext(context: BrowserContext, address: string, handsFree: boolean): Promise<void> {
  await installSpeechStub(context)
  await installMicrophone(context, handsFree)
  await context.route(/\/api\//, (route) =>
    route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': address } }),
  )
}

export const test = base.extend<{
  shot: Shot
  newDevice: () => Promise<Page>
  /** Hands-free voice with a microphone the test speaks into; tap-to-talk otherwise (see installMicrophone). */
  handsFree: boolean
}>({
  handsFree: [false, { option: true }],
  context: async ({ context, handsFree }, use, testInfo) => {
    await prepareContext(
      context,
      addressFor(`${testInfo.project.name}/${testInfo.titlePath.join('/')}`),
      handsFree,
    )
    await use(context)
  },
  /**
   * Another device of the same person: a browser context of its own, so no session, device key or
   * cookie is shared with the test's page. It comes from the same address as the test, so the
   * per-IP limits count both devices together, as they would behind one router.
   */
  newDevice: async ({ browser, handsFree }, use, testInfo) => {
    const contexts: BrowserContext[] = []
    await use(async () => {
      const context = await browser.newContext(testInfo.project.use)
      contexts.push(context)
      await prepareContext(
        context,
        addressFor(`${testInfo.project.name}/${testInfo.titlePath.join('/')}`),
        handsFree,
      )
      return context.newPage()
    })
    await Promise.all(contexts.map((context) => context.close()))
  },
  shot: async ({}, use, testInfo) => {
    await mkdir(SCREENSHOT_DIR, { recursive: true })
    const shot: Shot = async (page, name, options = {}) => {
      // Otherwise the breathing circle and Framework7 transitions give a different frame each run.
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.waitForTimeout(400)
      await page.screenshot({
        path: join(SCREENSHOT_DIR, `${testInfo.project.name}-${name}.png`),
        fullPage: options.fullPage ?? false,
      })
    }
    await use(shot)
  },
})

export { expect } from '@playwright/test'
