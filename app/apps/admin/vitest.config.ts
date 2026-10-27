import { testDatabase } from '@ryadom/db/test-db'
import { defineConfig } from 'vitest/config'

// The admin app's server code runs against the real core and a database of its own for this run (see
// @ryadom/db/test-db); the agent is stubbed through fetch.
const testDatabaseUrl = testDatabase().url

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      APP_ENV: 'local',
      LOG_LEVEL: 'silent',
      DATABASE_URL: testDatabaseUrl,
      AUTH_SECRET: 'test-auth-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
      PUBLIC_WEB_URL: 'http://localhost:3000',
      PUBLIC_APP_URL: 'http://localhost:3002',
      EMAIL_TRANSPORT: 'memory',
      EMAIL_FROM: 'Рядом <noreply@ryadom.local>',
      ADMIN_EMAILS: 'admin@example.com',
      AGENT_API_URL: 'http://agent.test',
      AGENT_API_TOKEN: 'test-agent-token',
    },
  },
})
