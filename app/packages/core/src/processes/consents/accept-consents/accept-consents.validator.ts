import { z } from 'zod'
import { consentVersionInputSchema } from '../../../config'

export const acceptConsentsSchema = z.object({
  offerVersion: consentVersionInputSchema,
})
