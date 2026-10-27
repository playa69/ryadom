import { addDaysToDate } from '../../../shared'
import { checkinsBetween } from './digests'

/** Days of «hard» (level 1) in a row ending at `date`, as far as the notes go (a week back). */
export async function hardStreakEnding(userId: string, date: string): Promise<number> {
  const recent = await checkinsBetween(userId, addDaysToDate(date, -6), date)
  const byDate = new Map(recent.map((d) => [d.date, d.mood]))
  let streak = 0
  for (let day = date; byDate.get(day) === 1; day = addDaysToDate(day, -1)) streak += 1
  return streak
}
