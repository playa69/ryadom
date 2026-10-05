import { z } from 'zod'
import { emailInputSchema } from '../../../config'

export const requestAdminCodeSchema = z.object({
  email: emailInputSchema,
})
