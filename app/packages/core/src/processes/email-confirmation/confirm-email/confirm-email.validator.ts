import { z } from 'zod'
import { emailInputSchema } from '../../../config'

export const confirmEmailSchema = z.object({
  email: emailInputSchema,
  code: z.string().regex(/^\d{6}$/, 'must be a 6-digit code'),
})
