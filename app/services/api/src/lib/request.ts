import { zValidator } from '@hono/zod-validator'
import type { z } from 'zod'
import { apiError } from './api-response'

/**
 * Parsing route input. The shape of the request (types, required fields, values from a fixed set)
 * is a 400: our interface never sends that, and an app update fixes it. Input rules a person can
 * violate, such as password length, are checked separately by the route and answered with 422; see
 * rules.ts.
 */

interface ValidationIssues {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>
}

function describe(error: ValidationIssues): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
}

export function jsonBody<T extends z.ZodType>(schema: T) {
  return zValidator('json', schema, (result, c) => {
    if (!result.success) return apiError(c, 400, `Invalid request body: ${describe(result.error)}`)
  })
}

export function queryParams<T extends z.ZodType>(schema: T) {
  return zValidator('query', schema, (result, c) => {
    if (!result.success) return apiError(c, 400, `Invalid query: ${describe(result.error)}`)
  })
}
