import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { RenderEmailConfirmationEmailRequest } from './render-email-confirmation-email.request'
import type { RenderEmailConfirmationEmailRequestResult } from './render-email-confirmation-email.types'
import { renderEmailConfirmationEmail } from '../emails/email-confirmation-email'

@requestHandler(RenderEmailConfirmationEmailRequest)
export class RenderEmailConfirmationEmailRequestHandler
  implements RequestHandler<RenderEmailConfirmationEmailRequest, RenderEmailConfirmationEmailRequestResult>
{
  async handle(request: RenderEmailConfirmationEmailRequest): Promise<RenderEmailConfirmationEmailRequestResult> {
    return {
      email: await renderEmailConfirmationEmail({
        userName: request.userName,
        code: request.code,
        expiresInMinutes: request.expiresInMinutes,
      }),
    }
  }
}
