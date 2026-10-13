import { z } from 'zod'
import { memoryFactTextInputSchema } from '../../../config'

export const createMemoryFactSchema = z.object({
  text: memoryFactTextInputSchema.nullable(),
})
