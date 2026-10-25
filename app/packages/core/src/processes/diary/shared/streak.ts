import { addDaysToDate } from '../../../shared'
import { checkinsBetween } from './digests'

/** How many days back one read goes; a longer streak is read in more steps. */
const STEP_DAYS = 400

/**
 * Consecutive marked local days ending today, or ending yesterday while today is not marked yet (the
 * streak is not lost before the day is over). 0 when neither day is marked. Only a plain counter for
 * the mood card (`REQ-WELL-01`): it never reaches the agent, the analytics or a notification.
 */
export async function markStreak(userId: string, today: string): Promise<number> {
  let upTo = today
  const marked = new Set<string>()
  let streak = 0
  let cursor: string | null = null
  for (;;) {
    const from = addDaysToDate(upTo, -(STEP_DAYS - 1))
    for (const entry of await checkinsBetween(userId, from, upTo)) marked.add(entry.date)
    if (cursor === null) {
      // Today may still be to come: count from yesterday then.
      cursor = marked.has(today) ? today : addDaysToDate(today, -1)
    }
    while (marked.has(cursor)) {
      streak += 1
      cursor = addDaysToDate(cursor, -1)
      if (cursor < from) break
    }
    // The run reached the start of what was read: read further back, otherwise it has ended.
    if (cursor >= from) return streak
    upTo = addDaysToDate(from, -1)
  }
}
