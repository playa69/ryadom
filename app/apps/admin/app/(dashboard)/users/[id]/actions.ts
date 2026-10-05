'use server'

import {
  ConfirmUserEmailOperation,
  ConfirmUserEmailOperationErrorCode,
  DeleteUserAccountOperation,
  DeleteUserAccountOperationErrorCode,
  RevokeUserSessionsOperation,
  RevokeUserSessionsOperationErrorCode,
  ToggleUserActivationOperation,
  ToggleUserActivationOperationErrorCode,
  userManagementProcess,
} from '@ryadom/core/processes/user-management'
import { AgentUnavailableError, createLogger } from '@ryadom/core/shared'
import assertNever from 'assert-never'
import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/session'
import { INITIAL_USER_ACTION_STATE, type UserActionState } from './shared'

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
  const typedEmail = String(formData.get('confirmEmail') ?? '').trim().toLowerCase()
  const actualEmail = String(formData.get('email') ?? '').trim().toLowerCase()

  // Typing the address is the only guard against deleting the wrong card by mistake: deletion
  // erases the conversations at the agent too and cannot be undone.
  if (!typedEmail || typedEmail !== actualEmail) {
    return { ok: null, error: 'Почта не совпала. Удаление отменено.' }
  }

  try {
    const result = await userManagementProcess.execute(
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

export async function noopState(): Promise<UserActionState> {
  return INITIAL_USER_ACTION_STATE
}
