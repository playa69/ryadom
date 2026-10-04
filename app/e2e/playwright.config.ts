import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end checks over the real stack: landing site, the PWA and the web app with the API they
 * share, the database, mail and the agent mock. Conversations are not checked on
 * their merits here - the agent is a mock; what is checked is that everything starts and wires
 * together.
 *
 * `scripts/stack.mjs` brings up the infrastructure and all the servers, and Playwright waits for
 * them via `webServer`, so `pnpm test:e2e` works locally and in CI with one command.
 */

export const WEB_URL = process.env.E2E_WEB_URL ?? 'http://127.0.0.1:3100'
export const APP_URL = process.env.E2E_APP_URL ?? 'http://127.0.0.1:3102'
/** The signed-in web app (apps/web). `baseURL` above is the landing site, not this one. */
export const WEBAPP_URL = process.env.E2E_WEBAPP_URL ?? 'http://127.0.0.1:3103'
/** Mailpit web UI: this is where the tests read the codes from the emails. */
export const MAIL_URL = process.env.E2E_MAIL_URL ?? 'http://127.0.0.1:8027'

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
    reuseExistingServer: !process.env.CI,
    timeout: 10 * 60 * 1000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
