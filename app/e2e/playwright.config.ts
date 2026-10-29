import { defineConfig, devices } from '@playwright/test'
import { resolveStand } from '../scripts/stand-ports.mjs'

/**
 * End-to-end checks over the real stack: landing site, the PWA and the web app with the API they
 * share, the database, mail and the agent mock. Conversations are not checked on
 * their merits here - the agent is a mock; what is checked is that everything starts and wires
 * together.
 *
 * `scripts/stack.mjs` brings up the infrastructure and all the servers, and Playwright waits for
 * them via `webServer`, so `pnpm e2e` works locally and in CI with one command.
 */

/**
 * The addresses of the worktree's stand (scripts/stand-ports.mjs; scripts/stack.mjs computes the same ones):
 * every worktree has ports of its own, so that agents working side by side do not meet on one stack. A worktree
 * without a slot gets the old fixed ones (3100, 3102, ...). `pnpm e2e` takes a slot before it starts.
 */
export const STAND = resolveStand()
const at = STAND.urls.e2e

export const WEB_URL = process.env.E2E_WEB_URL ?? at.landing
/** The API. It serves no client any more: the PWA below is a separate server. */
export const APP_URL = process.env.E2E_APP_URL ?? at.api
/** The signed-in web app (apps/web). `baseURL` above is the landing site, not this one. */
export const WEBAPP_URL = process.env.E2E_WEBAPP_URL ?? at.web
/** The PWA (apps/mobile web build), on its own origin with `/api` proxied to the API. */
export const PWA_URL = process.env.E2E_PWA_URL ?? at.pwa
/** Mailpit web UI: this is where the tests read the codes from the emails. */
export const MAIL_URL = process.env.E2E_MAIL_URL ?? at.mail
/** The agent mock: the tests feed it speech and memory through its dev endpoints. */
export const AGENT_URL = process.env.E2E_AGENT_URL ?? at.mock
/** The stack's database, for tests that write rows the API has no way to create. */
export const DATABASE_URL = process.env.E2E_DATABASE_URL ?? STAND.databases.e2e

/** A headless browser has no microphone of its own: the fake device plays a tone, and the fake prompt grants it. */
const FAKE_MICROPHONE = { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  // The tests share one database and one agent mock, so parallel runs would interfere.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: 'report', open: 'never' }]],
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
  },
  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 },
        launchOptions: FAKE_MICROPHONE,
      },
    },
    {
      name: 'mobile',
      use: {
        ...devices['Pixel 7'],
        // The mobile client's conversation opens on the voice screen and listens at once, so it
        // needs a microphone and its permission, or it would show a refusal.
        permissions: ['microphone'],
        launchOptions: FAKE_MICROPHONE,
      },
    },
  ],
  webServer: {
    command: 'node scripts/stack.mjs',
    // The landing site comes up last, so once it answers everything is up.
    url: `${WEB_URL}/api/health`,
    // Only when asked for (E2E_REUSE=1, with a stack started by `pnpm stand:up --e2e`): by default a server that is
    // already there is somebody else's, and a run against it would pass or fail on code that is not ours.
    reuseExistingServer: process.env.E2E_REUSE === '1',
    timeout: 10 * 60 * 1000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
