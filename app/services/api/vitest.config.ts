import { defineConfig } from 'vitest/config'

// The API runs for real against the real core and its own test database (ryadom_test_api from
// dev/postgres-init.sql), so that a parallel turbo run does not disturb the core's tests. The agent
// is stubbed through fetch and a WebSocket server started inside the test; email uses the memory
// transport.
const testDatabaseUrl =
  process.env.DATABASE_URL_TEST_API ?? 'postgres://ryadom:ryadom@localhost:55433/ryadom_test_api'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup.ts'],
    // All files share one database and clear it between tests, so they must run sequentially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      APP_ENV: 'local',
      LOG_LEVEL: 'silent',
      DATABASE_URL: testDatabaseUrl,
      DATABASE_URL_TEST_API: testDatabaseUrl,
      AUTH_SECRET: 'test-auth-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
      PUBLIC_WEB_URL: 'http://localhost:3000',
      PUBLIC_APP_URL: 'http://localhost:3002',
      EMAIL_TRANSPORT: 'memory',
      EMAIL_FROM: 'Рядом <noreply@ryadom.local>',
      ADMIN_EMAILS: '',
      AGENT_API_URL: 'http://agent.test',
      AGENT_API_TOKEN: 'test-agent-token',
      MOBILE_JWT_SECRET: 'test-mobile-jwt-secret-0123456789abcdef',
      MOBILE_ANDROID_STORE_URL: 'https://apps.rustore.ru/app/ru.ryadom.app',
    },
  },
})
