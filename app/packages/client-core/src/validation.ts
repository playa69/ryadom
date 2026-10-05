import { InputLimit } from '@ryadom/contracts/api/limits'

/**
 * Pre-submit checks, so a mistake surfaces immediately instead of after a round trip. The bounds
 * match the ones the server enforces, and the server still has the final word (422). Email format
 * is not checked here: whether an address is usable is the server's call.
 */
export function passwordProblem(value: string): string | null {
  if (value.length < InputLimit.PasswordMin) return `Пароль — не меньше ${InputLimit.PasswordMin} символов`
  if (value.length > InputLimit.PasswordMax) return `Пароль — не больше ${InputLimit.PasswordMax} символов`
  return null
}

export function nameProblem(value: string): string | null {
  const name = value.trim()
  if (!name) return 'Напиши, как тебя зовут'
  if (name.length > InputLimit.NameMax) return `Имя — не длиннее ${InputLimit.NameMax} символов`
  return null
}

export function codeProblem(value: string): string | null {
  return /^\d{6}$/.test(value.trim()) ? null : 'Код — шесть цифр из письма'
}
