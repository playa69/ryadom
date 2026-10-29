import { z } from 'zod'
import { VOICE_PIPELINES } from '@ryadom/db/schema'

export const setVoicePipelineSchema = z.object({
  pipeline: z.enum(VOICE_PIPELINES),
})
