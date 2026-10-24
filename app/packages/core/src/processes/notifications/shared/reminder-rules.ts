import { timeToMinutes } from '../../../shared'
import { PROCESSES_CONFIG } from '../../config'

const rules = PROCESSES_CONFIG.MOOD_REMINDER

/** 08:00 … 22:30, every 30 minutes. */
export function isValidReminderTime(time: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(time)) return false
  const minutes = timeToMinutes(time)
  return minutes >= rules.PICK_FROM_MINUTES && minutes <= rules.PICK_TO_MINUTES && minutes % rules.PICK_STEP_MINUTES === 0
}

/** One text a day for a person: the pick is by the local date. */
export function reminderTextFor(localDate: string): string {
  const day = Number(localDate.replaceAll('-', '')) || 0
  return rules.TEXTS[day % rules.TEXTS.length]!
}
