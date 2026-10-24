import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { diaryManager, GetMoodCheckinQuery } from '../../../managers/diary-manager'
import {
  ClaimReminderDeliveryCommand,
  ClaimReminderDeliveryCommandErrorCode,
  CountUnopenedRemindersQuery,
  DeletePushSubscriptionCommand,
  DeletePushSubscriptionCommandErrorCode,
  GetReminderDeliveryQuery,
  ListPushSubscriptionsQuery,
  ListReminderCandidatesQuery,
  MarkReminderDeliveryCommand,
  notificationsManager,
  PauseMoodReminderCommand,
  RecordPushResultCommand,
} from '../../../managers/notifications-manager'
import { reminderDeliveryService } from '../../../services/reminder-delivery-service'
import { createLogger, localMoment, timeToMinutes } from '../../../shared'
import { PROCESSES_CONFIG } from '../../config'
import { reminderTextFor } from '../shared/reminder-rules'

const log = createLogger('notifications')
import { RunReminderTickOperation } from './run-reminder-tick.operation'
import { type RunReminderTickResult } from './run-reminder-tick.types'

@requestHandler(RunReminderTickOperation)
export class RunReminderTickOperationHandler implements RequestHandler<RunReminderTickOperation, RunReminderTickResult> {
  async handle(c: RunReminderTickOperation): Promise<RunReminderTickResult> {
    // One minute of the scheduler (design D9): for everyone with a server-side channel whose local clock is inside
    // today's window, with no note today and not paused, the delivery of the day is inserted (the unique key lets
    // one replica win) and only the winner sends.
    const rules = PROCESSES_CONFIG.MOOD_REMINDER
    const now = c.now ?? new Date()
    const batch = c.batch ?? rules.BATCH
    let sent = 0
    let paused = 0
    let afterUserId: string | undefined
    for (;;) {
      const page = await notificationsManager.execute(new ListReminderCandidatesQuery({ limit: batch, afterUserId }))
      for (const person of page.candidates) {
        const local = localMoment(now, person.timezone)
        const due = timeToMinutes(person.time)
        const inWindow =
          local.minutes >= Math.max(due, rules.EARLIEST_MINUTES) &&
          local.minutes < Math.min(due + rules.GRACE_MINUTES, rules.LATEST_MINUTES)
        if (!inWindow) continue
        const marked = await diaryManager.execute(new GetMoodCheckinQuery({ userId: person.userId, localDate: local.date }))
        if (marked.checkin) continue
        const streak = await notificationsManager.execute(
          new CountUnopenedRemindersQuery({ userId: person.userId, since: person.streakResetAt, limit: rules.PAUSE_AFTER }),
        )
        if (streak.unopenedInRow >= rules.PAUSE_AFTER) {
          await notificationsManager.execute(new PauseMoodReminderCommand({ userId: person.userId }))
          paused += 1
          continue
        }
        const subs = await notificationsManager.execute(new ListPushSubscriptionsQuery({ userId: person.userId }))
        const channels = subs.subscriptions.filter(
          (s) => s.channel === 'web_push' || (s.channel === 'telegram' && person.telegramId !== null),
        )
        if (channels.length === 0) continue
        const claim = await notificationsManager.execute(
          new ClaimReminderDeliveryCommand({
            userId: person.userId,
            localDate: local.date,
            channel: channels.map((s) => s.channel).join('+'),
          }),
        )
        if (!claim.success) {
          switch (claim.error) {
            // Another replica (or an earlier tick) owns today's reminder of this person.
            case ClaimReminderDeliveryCommandErrorCode.ALREADY_CLAIMED:
              continue
            default:
              assertNever(claim.error)
          }
        }
        const { deliveryId } = await notificationsManager.execute(
          new GetReminderDeliveryQuery({ userId: person.userId, localDate: local.date }),
        )
        if (deliveryId === null) throw new Error('A delivery that was just claimed is not there')
        const text = reminderTextFor(local.date)
        const errors: string[] = []
        let delivered = false
        for (const sub of channels) {
          const outcome =
            sub.channel === 'web_push'
              ? await reminderDeliveryService.sendWebPush(
                  { endpoint: sub.endpoint ?? '', p256dh: sub.p256dh ?? '', auth: sub.auth ?? '' },
                  { title: rules.TITLE, body: text, url: '/diary?from=reminder', deliveryId },
                )
              : await reminderDeliveryService.sendTelegram(person.telegramId!, text, rules.BUTTON)
          if (outcome.ok) {
            delivered = true
            await notificationsManager.execute(new RecordPushResultCommand({ id: sub.id, ok: true }))
            continue
          }
          errors.push(outcome.error)
          if (!outcome.gone) {
            await notificationsManager.execute(new RecordPushResultCommand({ id: sub.id, ok: false }))
            continue
          }
          // The push service said 404/410 (or the bot is blocked): the address is dead.
          const removed = await notificationsManager.execute(new DeletePushSubscriptionCommand({ id: sub.id }))
          if (!removed.success) {
            switch (removed.error) {
              case DeletePushSubscriptionCommandErrorCode.SUBSCRIPTION_NOT_FOUND:
                break
              default:
                assertNever(removed.error)
            }
          }
        }
        if (errors.length > 0) {
          await notificationsManager.execute(new MarkReminderDeliveryCommand({ deliveryId, error: errors.join(',').slice(0, 200) }))
        }
        if (delivered) sent += 1
        else log.warn('Напоминание не доставлено ни одним каналом')
      }
      if (page.candidates.length < batch) break
      afterUserId = page.candidates[page.candidates.length - 1]!.userId
    }
    return { success: true, sent, paused }
  }
}
