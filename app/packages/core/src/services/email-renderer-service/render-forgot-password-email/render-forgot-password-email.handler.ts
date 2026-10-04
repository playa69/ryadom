import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { RenderForgotPasswordEmailRequest } from './render-forgot-password-email.request'
import type { RenderForgotPasswordEmailRequestResult } from './render-forgot-password-email.types'
import { renderForgotPasswordEmail } from '../emails/forgot-password-email'

@requestHandler(RenderForgotPasswordEmailRequest)
export class RenderForgotPasswordEmailRequestHandler
  implements RequestHandler<RenderForgotPasswordEmailRequest, RenderForgotPasswordEmailRequestResult>
{
  async handle(request: RenderForgotPasswordEmailRequest): Promise<RenderForgotPasswordEmailRequestResult> {
    return {
      email: await renderForgotPasswordEmail({
        userName: request.userName,
        code: request.code,
        expiresInMinutes: request.expiresInMinutes,
      }),
    }
  }
}
