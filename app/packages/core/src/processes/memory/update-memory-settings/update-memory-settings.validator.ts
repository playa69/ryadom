import { z } from 'zod'
import { consentVersionInputSchema } from '../../../config'

export const updateMemorySettingsSchema = z.object({
  consentVersion: consentVersionInputSchema.nullable(),
})
