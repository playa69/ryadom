import { diaryProcess, RunWeeklyDigestsOperation } from '@ryadom/core/processes/diary'
import { notificationsProcess, RunReminderTickOperation } from '@ryadom/core/processes/notifications'
import type { Logger } from './logger'

/**
 * Background work of the mood diary (design D9), one timer on every replica:
 *
 * - **Reminders, every minute.** Safe on any number of replicas: each delivery is a row with a unique
 *   key (person, kind, local day), and only the replica whose insert succeeds sends.
 * - **Week summaries, every ten minutes.** The finished week of whoever's local clock passed Monday 06:00.
 *   A repeat makes no second summary (a final one exists), so two replicas at once cost at most one
 *   extra model call.
 *
 * A failure is logged and the next tick tries again; nothing here may take the API down.
 */

const MINUTE_MS = 60_000

export function startDiaryScheduler(logger: Logger): () => void {
  let reminders = false
  let weeklies = false

  const remindersTimer = setInterval(() => {
    if (reminders) return
    reminders = true
    notificationsProcess
      .execute(new RunReminderTickOperation())
      .then((result) => {
        if (result.sent > 0 || result.paused > 0) logger.info({ sent: result.sent, paused: result.paused }, 'напоминания о настроении')
      })
      .catch((error: unknown) => logger.warn({ err: error }, 'Не удалось разослать напоминания о настроении'))
      .finally(() => {
        reminders = false
      })
  }, MINUTE_MS)

  const weeklyTimer = setInterval(() => {
    if (weeklies) return
    weeklies = true
    diaryProcess
      .execute(new RunWeeklyDigestsOperation())
      .then((result) => {
        if (result.weekly > 0 || result.yearly > 0) logger.info({ weekly: result.weekly, yearly: result.yearly }, 'итоги недели собраны')
      })
      .catch((error: unknown) => logger.warn({ err: error }, 'Не удалось собрать итоги недели'))
      .finally(() => {
        weeklies = false
      })
  }, 10 * MINUTE_MS)

  remindersTimer.unref()
  weeklyTimer.unref()
  return () => {
    clearInterval(remindersTimer)
    clearInterval(weeklyTimer)
  }
}
