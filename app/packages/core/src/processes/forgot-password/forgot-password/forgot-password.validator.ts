import { z } from 'zod'
import { AUTH_RULES } from '../../../config'

// The email format is not checked strictly: a wrong address simply will not be found, and the
// response is "ok" either way.
export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().min(1).max(AUTH_RULES.emailMaxLength),
})
