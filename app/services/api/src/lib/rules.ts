import type { z } from 'zod'

/**
 * Input rules the routes check themselves before the core: a violation is a 422 that the person can
 * fix. The rules are the core's own schemas (`emailInputSchema`, `passwordInputSchema`,
 * `nameInputSchema`, `codeInputSchema`); the core validates the same input again and throws if a
 * route let something through.
 */

/** The value parsed by a core input rule, or null, in which case the route answers 422. */
export function inputOrNull<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> | null {
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** Email for login and messages: trim and lowercase only, the format is validated by the core. */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}
