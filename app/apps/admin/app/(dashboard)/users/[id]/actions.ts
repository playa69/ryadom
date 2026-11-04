'use server'

import {
  accountDeletionProcess,
  DeleteUserAccountOperation,
  DeleteUserAccountOperationErrorCode,
} from '@ryadom/core/processes/account-deletion'
import {
  ConfirmUserEmailOperation,
  ConfirmUserEmailOperationErrorCode,
  RevokeUserSessionsOperation,
  RevokeUserSessionsOperationErrorCode,
  ToggleUserActivationOperation,
  ToggleUserActivationOperationErrorCode,
  userManagementProcess,
} from '@ryadom/core/processes/user-management'
import {
  NOTIFICATION_LIMITS,
  SendUserNotificationOperation,
  SendUserNotificationOperationErrorCode,
  notificationsProcess,
} from '@ryadom/core/processes/notifications'
import { AgentUnavailableError, createLogger } from '@ryadom/core/shared'
import assertNever from 'assert-never'
import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/session'
import type { NotificationFormState, UserActionState } from './shared'

const logger = createLogger('admin.users')

/**
 * Actions repeat requireAdmin: the layout guard protects rendering, not the endpoint a server
 * action exposes. Each operation writes to the audit log inside the core process.
 */

function refresh(userId: string): void {
  revalidatePath(`/users/${userId}`)
  revalidatePath('/users')
  revalidatePath('/audit')
}

export async function toggleActivation(_prev: UserActionState, formData: FormData): Promise<UserActionState> {
  const session = await requireAdmin()
  const userId = String(formData.get('userId') ?? '')

  const result = await userManagementProcess.execute(
    new ToggleUserActivationOperation({ adminEmail: session.email, userId }),
  )

  if (!result.success) {
    switch (result.error) {
      case ToggleUserActivationOperationErrorCode.USER_NOT_FOUND:
        return { ok: null, error: 'Пользователь не найден.' }
      case ToggleUserActivationOperationErrorCode.USER_DELETED:
        return { ok: null, error: 'Аккаунт удалён: блокировка к нему больше не применима.' }
      default:
        return assertNever(result.error)
    }
  }

  refresh(userId)
  return { ok: result.isActive ? 'Доступ восстановлен.' : 'Доступ закрыт.', error: null }
}

export async function confirmEmail(_prev: UserActionState, formData: FormData): Promise<UserActionState> {
  const session = await requireAdmin()
  const userId = String(formData.get('userId') ?? '')

  const result = await userManagementProcess.execute(
    new ConfirmUserEmailOperation({ adminEmail: session.email, userId }),
  )

  if (!result.success) {
    switch (result.error) {
      case ConfirmUserEmailOperationErrorCode.USER_NOT_FOUND:
        return { ok: null, error: 'Пользователь не найден.' }
      case ConfirmUserEmailOperationErrorCode.USER_HAS_NO_EMAIL:
        return { ok: null, error: 'У аккаунта нет почты: подтверждать нечего.' }
      default:
        return assertNever(result.error)
    }
  }

  refresh(userId)
  return { ok: 'Почта отмечена подтверждённой.', error: null }
}

/**
 * Signs the person out of every device without blocking the account (a lost phone, a doubt about
 * who else is in): unlike blocking, they can sign in again at once.
 */
export async function revokeSessions(_prev: UserActionState, formData: FormData): Promise<UserActionState> {
  const session = await requireAdmin()
  const userId = String(formData.get('userId') ?? '')

  const result = await userManagementProcess.execute(
    new RevokeUserSessionsOperation({ adminEmail: session.email, userId }),
  )

  if (!result.success) {
    switch (result.error) {
      case RevokeUserSessionsOperationErrorCode.USER_NOT_FOUND:
        return { ok: null, error: 'Пользователь не найден.' }
      case RevokeUserSessionsOperationErrorCode.USER_DELETED:
        return { ok: null, error: 'Аккаунт удалён: сессий у него уже нет.' }
      default:
        return assertNever(result.error)
    }
  }

  refresh(userId)
  return { ok: 'Все сессии завершены. Войти заново можно сразу.', error: null }
}

export async function deleteAccount(_prev: UserActionState, formData: FormData): Promise<UserActionState> {
  const session = await requireAdmin()
  const userId = String(formData.get('userId') ?? '')
  const typedEmail = String(formData.get('confirmEmail') ?? '')
    .trim()
    .toLowerCase()
  const actualEmail = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase()

  // Typing the address is the only guard against deleting the wrong card by mistake: deletion
  // erases the conversations at the agent too and cannot be undone.
  if (!typedEmail || typedEmail !== actualEmail) {
    return { ok: null, error: 'Почта не совпала. Удаление отменено.' }
  }

  try {
    const result = await accountDeletionProcess.execute(
      new DeleteUserAccountOperation({ adminEmail: session.email, userId }),
    )
    if (!result.success) {
      switch (result.error) {
        case DeleteUserAccountOperationErrorCode.USER_NOT_FOUND:
          return { ok: null, error: 'Пользователь не найден.' }
        case DeleteUserAccountOperationErrorCode.ALREADY_DELETED:
          return { ok: null, error: 'Аккаунт уже удалён.' }
        default:
          return assertNever(result.error)
      }
    }
  } catch (error) {
    if (error instanceof AgentUnavailableError) {
      // Nothing was deleted: the account is erased at the agent first, and only then here.
      logger.error('Account deletion aborted: agent unavailable', error, { userId })
      return { ok: null, error: 'Сервис диалогов недоступен, данные не тронуты. Повторите позже.' }
    }
    throw error
  }

  refresh(userId)
  return { ok: 'Аккаунт удалён, разговоры стёрты.', error: null }
}

/** «устройства» after 1, 21, 31…, otherwise «устройств»: «из 1 устройства», «из 2 устройств». */
function devices(count: number): string {
  return count % 10 === 1 && count % 100 !== 11 ? 'устройства' : 'устройств'
}

function lengthProblem(value: string, max: number, empty: string): string | undefined {
  if (value === '') return empty
  if (value.length > max) return `Не длиннее ${max} символов, сейчас ${value.length}.`
  return undefined
}

/**
 * A notification to every device of the person with notifications on. The lengths are checked here first, so that the
 * admin sees the field to fix rather than a failure of the core; the core checks them again and writes the audit entry
 * whatever the push service answered.
 */
export async function sendNotification(
  _prev: NotificationFormState,
  formData: FormData,
): Promise<NotificationFormState> {
  const session = await requireAdmin()
  const userId = String(formData.get('userId') ?? '')
  const values = {
    title: String(formData.get('title') ?? '').trim(),
    body: String(formData.get('body') ?? '').trim(),
  }
  const failed = (error: string): NotificationFormState => ({ ok: null, error, fieldErrors: {}, values })

  const fieldErrors = {
    title: lengthProblem(values.title, NOTIFICATION_LIMITS.titleMaxLength, 'Напишите заголовок.'),
    body: lengthProblem(values.body, NOTIFICATION_LIMITS.bodyMaxLength, 'Напишите текст.'),
  }
  if (fieldErrors.title || fieldErrors.body) return { ok: null, error: null, fieldErrors, values }

  const result = await notificationsProcess.execute(
    new SendUserNotificationOperation({ adminEmail: session.email, userId, ...values, link: null }),
  )
  if (!result.success) {
    switch (result.error) {
      case SendUserNotificationOperationErrorCode.USER_NOT_FOUND:
        return failed('Пользователь не найден.')
      case SendUserNotificationOperationErrorCode.USER_DELETED:
        return failed('Аккаунт удалён: уведомление отправить некому.')
      default:
        return assertNever(result.error)
    }
  }

  // The audit has a new entry either way, and a device the push service forgot is gone from the card.
  refresh(userId)
  if (result.total === 0) {
    return failed('Не отправлено ни на одно устройство: нет устройств с включёнными уведомлениями.')
  }
  if (result.sent === 0) return failed('Не отправлено ни на одно устройство: push-сервис не принял.')
  return {
    ok: `Отправлено на ${result.sent} из ${result.total} ${devices(result.total)}.`,
    error: null,
    fieldErrors: {},
    values: { title: '', body: '' },
  }
}
