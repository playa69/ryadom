import { z } from 'zod'
import { memoryFactTextInputSchema } from '../../../config'

export const updateMemoryFactSchema = z.object({
  factId: z.string().min(1).max(200),
  text: memoryFactTextInputSchema,
})
