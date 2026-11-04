import { z } from 'zod'
import { PROCESSES_CONFIG } from '../../config'

const { TITLE_MAX_LENGTH, BODY_MAX_LENGTH } = PROCESSES_CONFIG.NOTIFICATIONS

export const sendUserNotificationSchema = z.object({
  title: z.string().trim().min(1).max(TITLE_MAX_LENGTH),
  body: z.string().trim().min(1).max(BODY_MAX_LENGTH),
  // A path of the app; the client opens it only if it is one of its routes.
  link: z.string().startsWith('/').max(200).nullable(),
})
