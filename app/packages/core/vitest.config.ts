import { defineConfig } from 'vitest/config'

// Tests talk to a real Postgres (ryadom_test from dev/compose.yaml); outbound HTTP goes through
// vi.stubGlobal('fetch') and emails use the memory transport.
const testDatabaseUrl =
  process.env.DATABASE_URL_TEST ?? 'postgres://ryadom:ryadom@localhost:55433/ryadom_test'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup.ts'],
    // All files share one database and clean it between tests, so they must run sequentially.
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
