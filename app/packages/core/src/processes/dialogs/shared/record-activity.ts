import { addMinutes } from '../../../shared'
import { TouchUserActivityCommand, usersManager } from '../../../managers/users-manager'
import { PROCESSES_CONFIG } from '../../config'

/** Notes that the person was seen just now: starting a conversation is the clearest sign of it. */
export async function recordActivity(userId: string): Promise<void> {
  const now = new Date()
  await usersManager.execute(
    new TouchUserActivityCommand({
      userId,
      at: now,
      unlessSeenAfter: addMinutes(now, -PROCESSES_CONFIG.ACTIVITY.WRITE_INTERVAL_MINUTES),
    }),
  )
}
