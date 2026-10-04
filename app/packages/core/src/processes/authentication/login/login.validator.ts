import { z } from 'zod'
import { AUTH_RULES } from '../../../config'

// The email format is not checked strictly on sign-in: a wrong address simply will not be found
// (INVALID_CREDENTIALS).
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1).max(AUTH_RULES.emailMaxLength),
  password: z.string().min(1).max(1024),
})
