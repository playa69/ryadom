import { z } from 'zod'
import { AUTH_RULES } from './helpers'

/**
 * Input rules shared by the core (operation validators) and the server side of the applications.
 * Email is normalized: surrounding spaces are trimmed and the case is lowered.
 */
export const emailInputSchema = z.string().trim().toLowerCase().pipe(z.email().max(AUTH_RULES.emailMaxLength))

export const passwordInputSchema = z
  .string()
  .min(AUTH_RULES.passwordMinLength)
  .max(AUTH_RULES.passwordMaxLength)

export const nameInputSchema = z.string().trim().min(1).max(AUTH_RULES.nameMaxLength)

/** Code from an email: exactly six digits. */
export const codeInputSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'must be a 6-digit code')
