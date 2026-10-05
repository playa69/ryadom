import type { AuditLogAction } from '@ryadom/core/managers/audit-log-manager'
import type { UserDTO } from '@ryadom/core/managers/users-manager'
import type { Tone } from '@/components/status-badge'

export const AUDIT_ACTION_LABELS: Record<AuditLogAction, string> = {
  USER_BLOCKED: 'Заблокирован',
  USER_UNBLOCKED: 'Разблокирован',
  USER_EMAIL_CONFIRMED: 'Почта подтверждена вручную',
  USER_ACCOUNT_DELETED: 'Аккаунт удалён',
}

export const AUDIT_ACTION_TONES: Record<AuditLogAction, Tone> = {
  USER_BLOCKED: 'danger',
  USER_UNBLOCKED: 'success',
  USER_EMAIL_CONFIRMED: 'info',
  USER_ACCOUNT_DELETED: 'dark',
}

export interface UserStatus {
  label: string
  tone: Tone
}

/** Deleted wins over blocked: a deleted account is always inactive, and that is the fact to show. */
export function userStatus(user: UserDTO): UserStatus {
  if (user.isDeleted) return { label: 'Удалён', tone: 'dark' }
  if (!user.isActive) return { label: 'Заблокирован', tone: 'danger' }
  return { label: 'Активен', tone: 'success' }
}

const dateFormat = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Moscow',
})

/** Always Moscow time: admins are here and the server may run anywhere. */
export function formatMoscow(value: Date): string {
  return dateFormat.format(value)
}

const PAYLOAD_KEYS: Record<string, string> = { reason: 'причина' }

/** Audit details as a short phrase; an empty payload is a dash, not `{}`. */
export function describePayload(payload: Record<string, unknown> | null): string {
  const entries = Object.entries(payload ?? {})
  if (entries.length === 0) return '—'
  return entries.map(([key, value]) => `${PAYLOAD_KEYS[key] ?? key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join(', ')
}
