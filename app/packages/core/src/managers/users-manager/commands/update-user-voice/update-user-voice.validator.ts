import { z } from 'zod'

export const updateUserVoiceSchema = z.object({
  voice: z.enum(['male', 'female']),
})
