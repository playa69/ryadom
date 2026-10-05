import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { RenderWelcomeEmailRequest } from './render-welcome-email.request'
import type { RenderWelcomeEmailRequestResult } from './render-welcome-email.types'
import { renderWelcomeEmail } from '../emails/welcome-email'

@requestHandler(RenderWelcomeEmailRequest)
export class RenderWelcomeEmailRequestHandler implements RequestHandler<RenderWelcomeEmailRequest, RenderWelcomeEmailRequestResult> {
  async handle(request: RenderWelcomeEmailRequest): Promise<RenderWelcomeEmailRequestResult> {
    return {
      email: await renderWelcomeEmail({
        userName: request.userName,
        code: request.code,
        expiresInMinutes: request.expiresInMinutes,
      }),
    }
  }
}
