import { z } from 'zod'
import { codeInputSchema, emailInputSchema } from '../../../config'

export const confirmAdminCodeSchema = z.object({
  email: emailInputSchema,
  code: codeInputSchema,
})
