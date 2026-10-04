import { z } from 'zod'
import { deviceIdInputSchema, deviceKeyInputSchema } from '../../../config'

export const deviceLoginSchema = z.object({
  deviceId: deviceIdInputSchema,
  deviceKey: deviceKeyInputSchema,
})
