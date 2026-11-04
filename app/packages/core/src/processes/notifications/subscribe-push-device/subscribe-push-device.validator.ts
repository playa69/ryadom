import { z } from 'zod'
import { PUSH_CHANNELS } from '@ryadom/db/schema'

export const subscribePushDeviceSchema = z.object({
  channel: z.enum(PUSH_CHANNELS),
  token: z.string().min(1).max(4096),
  projectId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  appId: z
    .string()
    .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)
    .max(255),
})
