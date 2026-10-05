// 1. Handler imports
import './send-email/send-email.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { SendEmailRequest } from './send-email/send-email.request'
export type { SendEmailRequestData } from './send-email/send-email.request'

// 3. Type re-exports
export type { SendEmailRequestResult } from './send-email/send-email.types'
export { getSentEmails, clearSentEmails, type SentEmail } from './transports/memory'

// 4. Union type
import type { SendEmailRequest } from './send-email/send-email.request'

export type EmailSenderServiceRequests = SendEmailRequest

// 5. Facade
export class EmailSenderService implements IEmailSenderService {
  async execute<T extends EmailSenderServiceRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: EmailSenderServiceRequests) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IEmailSenderService {
  execute<T extends EmailSenderServiceRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never>
}

export const emailSenderService: IEmailSenderService = new EmailSenderService()
