import { addMinutes } from '../../../shared'
import { TouchUserActivityCommand, usersManager } from '../../../managers/users-manager'
import { PROCESSES_CONFIG } from '../../config'

/** Notes that the person was seen just now: sign-in is the surest sign that someone is there. */
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
