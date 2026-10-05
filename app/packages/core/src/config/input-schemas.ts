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

/** The id the app makes for a device on first launch: random, URL-safe. */
export const deviceIdInputSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16,64}$/, 'must be 16 to 64 URL-safe characters')

/** The device's secret key: 256 random bits as URL-safe base64, with room for other encodings. */
export const deviceKeyInputSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{32,128}$/, 'must be 32 to 128 URL-safe characters')

/** The version of the terms a person was shown: the date they came into force, `2026-10-04`. */
export const consentVersionInputSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date such as 2026-10-04')
