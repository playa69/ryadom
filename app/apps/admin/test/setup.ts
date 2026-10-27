import { afterAll, beforeEach, vi } from 'vitest'
import { resetEnvCache } from '@ryadom/core/config'
import { registerJobQueueTransport } from '@ryadom/core/services/job-queue-service'
import { closeDb } from '@ryadom/core/shared'
import { handle } from './db'

beforeEach(async () => {
  vi.unstubAllGlobals()
  resetEnvCache()
  // Each test registers the transport it is about; none is left over from the one before.
  registerJobQueueTransport(undefined)
  await handle.sql.unsafe(
    'truncate table audit_log, refresh_tokens, user_devices, users restart identity cascade',
  )
  await handle.sql.unsafe('delete from pgboss.job')
})

afterAll(async () => {
  await closeDb()
  await handle.close()
})
