import { z } from 'zod'
import { nameInputSchema } from '../../../../config'

export const updateUserNameSchema = z.object({
  name: nameInputSchema,
})
