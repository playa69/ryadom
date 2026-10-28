import { afterAll, beforeEach, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { closeDb, getDb } from '@ryadom/core/shared'
import { resetEnvCache } from '@ryadom/core/config'
import { clearSentEmails } from '@ryadom/core/services/email-sender-service'
import {
  clearEnqueuedJobs,
  memoryJobQueueTransport,
  registerJobQueueTransport,
} from '@ryadom/core/services/job-queue-service'

const TABLES = ['audit_log', 'email_codes', 'refresh_tokens', 'user_credentials', 'user_devices', 'users', 'voice_settings']

beforeEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  resetEnvCache()
  clearSentEmails()
  // The tests keep the jobs in memory; the tests of the real queue register it for their own duration.
  registerJobQueueTransport(memoryJobQueueTransport)
  clearEnqueuedJobs()
  await getDb().execute(sql.raw(`truncate table ${TABLES.join(', ')} restart identity cascade`))
})

afterAll(async () => {
  await closeDb()
})
