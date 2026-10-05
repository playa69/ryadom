import { z } from 'zod'
import { emailInputSchema, nameInputSchema, passwordInputSchema } from '../../../config'

export const registerSchema = z.object({
  email: emailInputSchema,
  password: passwordInputSchema,
  name: nameInputSchema,
})
