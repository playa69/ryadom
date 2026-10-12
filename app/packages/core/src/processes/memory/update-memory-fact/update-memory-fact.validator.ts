import { z } from 'zod'
import { memoryFactTextInputSchema } from '../../../config'

export const updateMemoryFactSchema = z
  .object({
    factId: z.string().min(1).max(200),
    text: memoryFactTextInputSchema.optional(),
    hasSlots: z.boolean(),
    status: z.enum(['active', 'pinned']).optional(),
    confirm: z.literal(true).optional(),
  })
  .refine(
    (input) =>
      input.text !== undefined || input.hasSlots || input.status !== undefined || input.confirm !== undefined,
    'nothing to change',
  )
