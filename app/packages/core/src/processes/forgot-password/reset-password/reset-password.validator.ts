import { z } from 'zod'
import { emailInputSchema, passwordInputSchema } from '../../../config'

export const resetPasswordSchema = z.object({
  email: emailInputSchema,
  code: z.string().regex(/^\d{6}$/, 'must be a 6-digit code'),
  newPassword: passwordInputSchema,
})
