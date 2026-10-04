import { afterAll, beforeEach, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { closeDb, getDb } from '@ryadom/core/shared'
import { resetEnvCache } from '@ryadom/core/config'
import { clearSentEmails } from '@ryadom/core/services/email-sender-service'

const TABLES = ['audit_log', 'email_codes', 'refresh_tokens', 'user_credentials', 'users']

beforeEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  resetEnvCache()
  clearSentEmails()
  await getDb().execute(sql.raw(`truncate table ${TABLES.join(', ')} restart identity cascade`))
})

afterAll(async () => {
  await closeDb()
})
