import type { ServerAnalytics } from '@ryadom/analytics/server'
import { JobQueue } from '@ryadom/core/services/job-queue-service'
import type { Sessions } from '../lib/sessions'
import { diaryPassJob } from './diary-pass'
import { purgeAnonymousJob } from './purge-anonymous'
import { purgeSessionsJob } from './purge-sessions'
import type { JobHandlers } from './registry'

/** What the jobs need from the rest of the API. */
export interface JobDeps {
  sessions: Pick<Sessions, 'purgeExpired'>
  analytics: Pick<ServerAnalytics, 'capture'>
}

/** The work of each queue. A queue without an entry here has no worker (the receiver of dead jobs). */
export function createHandlers(deps: JobDeps): JobHandlers {
  return {
    [JobQueue.SessionsPurgeExpired]: purgeSessionsJob(deps.sessions),
    [JobQueue.AccountsPurgeInactiveAnonymous]: purgeAnonymousJob(),
    [JobQueue.DiaryWeeklyPass]: diaryPassJob(deps.analytics),
  }
}
