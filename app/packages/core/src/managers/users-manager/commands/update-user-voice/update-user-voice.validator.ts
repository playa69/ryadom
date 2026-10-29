import { z } from 'zod'

export const updateUserVoiceSchema = z.object({
  voice: z.enum(['male', 'female']),
  // The API checks the name against the catalog of voices; this only keeps junk out of the table.
  voiceName: z
    .string()
    .regex(/^[A-Za-z]{2,32}$/)
    .nullable(),
})
