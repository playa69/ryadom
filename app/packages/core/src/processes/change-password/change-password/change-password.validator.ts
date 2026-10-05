import { z } from 'zod'
import { passwordInputSchema } from '../../../config'

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: passwordInputSchema,
})
