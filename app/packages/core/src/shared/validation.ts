import type { z } from 'zod'
import { ValidationError } from './errors'

/**
 * Validates input against a zod schema from `*.validator.ts`. Invalid input is a bug in the
 * calling code (the application must validate earlier), so this throws instead of returning an
 * error code.
 */
export function validateInput<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.map(String).join('.')
      return path ? `${path}: ${issue.message}` : issue.message
    })
    throw new ValidationError(`Validation failed: ${issues.join(', ')}`, issues)
  }
  return result.data
}
