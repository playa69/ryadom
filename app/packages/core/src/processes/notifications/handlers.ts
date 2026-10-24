import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { createLogger } from '../../shared'
import {
  ClaimReminderDeliveryCommand,
  CountUnopenedRemindersQuery,
  CreatePushSubscriptionCommand,
  CreateWidgetTokenCommand,
  DeletePushSubscriptionCommand,
  FindWidgetTokenQuery,
  GetNotificationSettingsQuery,
  HasMoodCheckinQuery,
  ListPushSubscriptionsQuery,
  ListReminderCandidatesQuery,
  MarkReminderDeliveryCommand,
  MarkReminderOpenedCommand,
  PauseMoodReminderCommand,
  RecordPushResultCommand,
  RevokeWidgetTokensCommand,
  UpdateNotificationSettingsCommand,
  notificationsManager,
} from '../../managers/notifications-manager'
import { GetUserByIdQuery, usersManager } from '../../managers/users-manager'
import { reminderDeliveryService } from '../../services/reminder-delivery-service'
import { localMoment, timeToMinutes } from '../../diary/local-time'
import {
  CreateSubscriptionOperation,
  CreateWidgetTokenOperation,
  DeleteSubscriptionOperation,
  GetNotificationSettingsOperation,
  MarkReminderOpenedOperation,
  NotificationsOperationErrorCode,
  ResolveWidgetTokenOperation,
  RevokeWidgetTokenOperation,
  RunReminderTickOperation,
  UpdateNotificationSettingsOperation,
  type ReminderTickResult,
} from './operations'

const log = createLogger('notifications')

/** Reminder window (design D8): not before 08:00, not after 23:00, and not later than 2 hours after the set time. */
export const REMINDER_EARLIEST_MINUTES = 8 * 60
export const REMINDER_LATEST_MINUTES = 23 * 60
export const REMINDER_GRACE_MINUTES = 120
/** Unopened reminders in a row after which they pause. */
export const REMINDER_PAUSE_AFTER = 7

/**
 * Gentle phrases, no guilt, no counting of days, never more insistent after a miss. A set to be approved
 * by the psychologist (add-mood-diary, task 0.3); the pick is by the local date, so one person sees one text a day.
 */
export const REMINDER_TEXTS = [
  'Как ты сегодня? Отметь настроение в два касания',
  'Хочешь отметить, как прошёл день? Это займёт пару секунд',
  'Загляни на минутку: как ты сейчас?',
  'Если есть минутка, отметь, как ты себя чувствуешь',
  'Как день? Можно отметить настроение — Рядом будет рядом',
  'Тихий вечерний вопрос: как ты?',
] as const
export const REMINDER_TITLE = 'Рядом'
export const REMINDER_BUTTON = 'Отметить'

export function reminderTextFor(localDate: string): string {
  const day = Number(localDate.replaceAll('-', '')) || 0
  return REMINDER_TEXTS[day % REMINDER_TEXTS.length]!
}

/** 08:00 … 22:30, every 30 minutes. */
export function isValidReminderTime(time: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(time)) return false
  const minutes = timeToMinutes(time)
  return minutes >= 8 * 60 && minutes <= 22 * 60 + 30 && minutes % 30 === 0
}

const fail = (error: NotificationsOperationErrorCode) => ({ success: false as const, error })

async function settingsAndSubscriptions(userId: string) {
  const [settings, subs] = await Promise.all([
    notificationsManager.execute(new GetNotificationSettingsQuery({ userId })),
    notificationsManager.execute(new ListPushSubscriptionsQuery({ userId })),
  ])
  return { success: true as const, settings: settings.settings, subscriptions: subs.subscriptions }
}

async function userExists(userId: string): Promise<boolean> {
  const found = await usersManager.execute(new GetUserByIdQuery({ userId }))
  return found.success && !found.user.isDeleted
}

@requestHandler(GetNotificationSettingsOperation)
export class GetNotificationSettingsOperationHandler implements RequestHandler<GetNotificationSettingsOperation, Awaited<ReturnType<typeof settingsAndSubscriptions>> | ReturnType<typeof fail>> {
  async handle(operation: GetNotificationSettingsOperation) {
    if (!(await userExists(operation.data.userId))) return fail(NotificationsOperationErrorCode.USER_NOT_FOUND)
    return settingsAndSubscriptions(operation.data.userId)
  }
}

@requestHandler(UpdateNotificationSettingsOperation)
export class UpdateNotificationSettingsOperationHandler implements RequestHandler<UpdateNotificationSettingsOperation, Awaited<ReturnType<typeof settingsAndSubscriptions>> | ReturnType<typeof fail>> {
  async handle(operation: UpdateNotificationSettingsOperation) {
    const { userId, enabled, time, offerAnswered } = operation.data
    if (time !== undefined && !isValidReminderTime(time)) return fail(NotificationsOperationErrorCode.INVALID_TIME)
    if (!(await userExists(userId))) return fail(NotificationsOperationErrorCode.USER_NOT_FOUND)
    await notificationsManager.execute(new UpdateNotificationSettingsCommand({ userId, enabled, time, offerAnswered }))
    return settingsAndSubscriptions(userId)
  }
}

@requestHandler(CreateSubscriptionOperation)
export class CreateSubscriptionOperationHandler implements RequestHandler<CreateSubscriptionOperation, { success: true; id: string } | ReturnType<typeof fail>> {
  async handle(operation: CreateSubscriptionOperation) {
    const { userId, channel, endpoint, p256dh, auth, deviceLabel } = operation.data
    const found = await usersManager.execute(new GetUserByIdQuery({ userId }))
    if (!found.success || found.user.isDeleted) return fail(NotificationsOperationErrorCode.USER_NOT_FOUND)
    if (channel === 'web_push') {
      const valid = endpoint && p256dh && auth && /^https:\/\//.test(endpoint) && endpoint.length <= 2048
      if (!valid) return fail(NotificationsOperationErrorCode.INVALID_SUBSCRIPTION)
    }
    if (channel === 'telegram' && found.user.telegramId === null) {
      return fail(NotificationsOperationErrorCode.TELEGRAM_NOT_LINKED)
    }
    const created = await notificationsManager.execute(
      new CreatePushSubscriptionCommand({ userId, channel, endpoint, p256dh, auth, deviceLabel: deviceLabel?.slice(0, 80) }),
    )
    return { success: true as const, id: created.subscription.id }
  }
}

@requestHandler(DeleteSubscriptionOperation)
export class DeleteSubscriptionOperationHandler implements RequestHandler<DeleteSubscriptionOperation, { success: true } | ReturnType<typeof fail>> {
  async handle(operation: DeleteSubscriptionOperation) {
    const { userId, id } = operation.data
    if (!/^[0-9a-f-]{36}$/i.test(id)) return fail(NotificationsOperationErrorCode.SUBSCRIPTION_NOT_FOUND)
    const deleted = await notificationsManager.execute(new DeletePushSubscriptionCommand({ id, userId }))
    return deleted.success ? { success: true as const } : fail(NotificationsOperationErrorCode.SUBSCRIPTION_NOT_FOUND)
  }
}

@requestHandler(MarkReminderOpenedOperation)
export class MarkReminderOpenedOperationHandler implements RequestHandler<MarkReminderOpenedOperation, { success: true }> {
  async handle(operation: MarkReminderOpenedOperation) {
    await notificationsManager.execute(new MarkReminderOpenedCommand(operation.data))
    return { success: true as const }
  }
}

@requestHandler(CreateWidgetTokenOperation)
export class CreateWidgetTokenOperationHandler implements RequestHandler<CreateWidgetTokenOperation, { success: true; token: string } | ReturnType<typeof fail>> {
  async handle(operation: CreateWidgetTokenOperation) {
    if (!(await userExists(operation.data.userId))) return fail(NotificationsOperationErrorCode.USER_NOT_FOUND)
    return notificationsManager.execute(new CreateWidgetTokenCommand(operation.data))
  }
}

@requestHandler(RevokeWidgetTokenOperation)
export class RevokeWidgetTokenOperationHandler implements RequestHandler<RevokeWidgetTokenOperation, { success: true }> {
  async handle(operation: RevokeWidgetTokenOperation) {
    return notificationsManager.execute(new RevokeWidgetTokensCommand(operation.data))
  }
}

@requestHandler(ResolveWidgetTokenOperation)
export class ResolveWidgetTokenOperationHandler implements RequestHandler<ResolveWidgetTokenOperation, { success: true; userId: string | null }> {
  async handle(operation: ResolveWidgetTokenOperation) {
    return notificationsManager.execute(new FindWidgetTokenQuery(operation.data))
  }
}

@requestHandler(RunReminderTickOperation)
export class RunReminderTickOperationHandler implements RequestHandler<RunReminderTickOperation, ReminderTickResult> {
  async handle(operation: RunReminderTickOperation): Promise<ReminderTickResult> {
    const { now = new Date(), batch = 500 } = operation.data
    let sent = 0
    let paused = 0
    let afterUserId: string | undefined
    // Pages of `batch` people, so one tick never holds the whole table.
    for (;;) {
      const page = await notificationsManager.execute(new ListReminderCandidatesQuery({ limit: batch, afterUserId }))
      for (const person of page.candidates) {
        const local = localMoment(now, person.timezone)
        const due = timeToMinutes(person.time)
        const inWindow =
          local.minutes >= Math.max(due, REMINDER_EARLIEST_MINUTES) &&
          local.minutes < Math.min(due + REMINDER_GRACE_MINUTES, REMINDER_LATEST_MINUTES)
        if (!inWindow) continue
        const marked = await notificationsManager.execute(new HasMoodCheckinQuery({ userId: person.userId, localDate: local.date }))
        if (marked.has) continue
        const streak = await notificationsManager.execute(
          new CountUnopenedRemindersQuery({ userId: person.userId, since: person.streakResetAt, limit: REMINDER_PAUSE_AFTER }),
        )
        if (streak.unopenedInRow >= REMINDER_PAUSE_AFTER) {
          await notificationsManager.execute(new PauseMoodReminderCommand({ userId: person.userId }))
          paused += 1
          continue
        }
        const subs = await notificationsManager.execute(new ListPushSubscriptionsQuery({ userId: person.userId }))
        const channels = subs.subscriptions.filter((s) => s.channel === 'web_push' || (s.channel === 'telegram' && person.telegramId !== null))
        if (channels.length === 0) continue
        const claim = await notificationsManager.execute(
          new ClaimReminderDeliveryCommand({ userId: person.userId, localDate: local.date, channel: channels.map((c) => c.channel).join('+') }),
        )
        // Another replica (or an earlier tick) owns today's reminder of this person.
        if (!claim.claimed || claim.deliveryId === null) continue
        const deliveryId = claim.deliveryId
        const text = reminderTextFor(local.date)
        const errors: string[] = []
        let delivered = false
        for (const sub of channels) {
          const outcome =
            sub.channel === 'web_push'
              ? await reminderDeliveryService.sendWebPush(
                  { endpoint: sub.endpoint ?? '', p256dh: sub.p256dh ?? '', auth: sub.auth ?? '' },
                  { title: REMINDER_TITLE, body: text, url: '/diary?from=reminder', deliveryId },
                )
              : await reminderDeliveryService.sendTelegram(person.telegramId!, text, REMINDER_BUTTON)
          if (outcome.ok) {
            delivered = true
            await notificationsManager.execute(new RecordPushResultCommand({ id: sub.id, ok: true }))
            continue
          }
          errors.push(outcome.error)
          if (outcome.gone) await notificationsManager.execute(new DeletePushSubscriptionCommand({ id: sub.id }))
          else await notificationsManager.execute(new RecordPushResultCommand({ id: sub.id, ok: false }))
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
