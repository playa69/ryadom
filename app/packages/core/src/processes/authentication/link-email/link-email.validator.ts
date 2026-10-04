import { z } from 'zod'
import { emailInputSchema, passwordInputSchema } from '../../../config'

export const linkEmailSchema = z.object({
  email: emailInputSchema,
  password: passwordInputSchema,
})
