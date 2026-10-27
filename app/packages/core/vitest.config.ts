import { testDatabase } from '@ryadom/db/test-db'
import { defineConfig } from 'vitest/config'

// Tests talk to a real Postgres, in a database created for this run (see @ryadom/db/test-db); outbound HTTP goes
// through vi.stubGlobal('fetch') and emails use the memory transport.
const testDatabaseUrl = testDatabase({ explicitUrl: process.env.DATABASE_URL_TEST }).url

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup.ts'],
    // All files of the run share its database and clean it between tests, so they must run sequentially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      APP_ENV: 'local',
      LOG_LEVEL: 'silent',
      DATABASE_URL: testDatabaseUrl,
      DATABASE_URL_TEST: testDatabaseUrl,
      AUTH_SECRET: 'test-auth-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
      PUBLIC_WEB_URL: 'http://localhost:3000',
      PUBLIC_APP_URL: 'http://localhost:3002',
      EMAIL_TRANSPORT: 'memory',
      EMAIL_FROM: 'Рядом <noreply@ryadom.local>',
      ADMIN_EMAILS: 'admin@example.com, second-admin@example.com',
      AGENT_API_URL: 'http://agent.test',
      AGENT_API_TOKEN: 'test-agent-token',
    },
  },
})
