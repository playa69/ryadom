import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { createLogger } from '../../../shared'
import { SendEmailRequest } from './send-email.request'
import type { SendEmailRequestResult } from './send-email.types'
import { emailSenderConfig, getEmailTransport } from '../config'

/** Sends through the configured transport. A failure throws: whether to swallow it is up to the caller. */
@requestHandler(SendEmailRequest)
export class SendEmailRequestHandler implements RequestHandler<SendEmailRequest, SendEmailRequestResult> {
  async handle(request: SendEmailRequest): Promise<SendEmailRequestResult> {
    const { messageId } = await getEmailTransport().send({
      from: emailSenderConfig.from,
      to: request.to,
      subject: request.subject,
      html: request.html,
      text: request.text,
    })
    createLogger('email-sender-service').info('Email sent', { messageId, subject: request.subject })
    return { messageId }
  }
}
