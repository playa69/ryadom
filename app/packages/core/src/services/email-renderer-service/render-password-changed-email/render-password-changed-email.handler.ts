import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { RenderPasswordChangedEmailRequest } from './render-password-changed-email.request'
import type { RenderPasswordChangedEmailRequestResult } from './render-password-changed-email.types'
import { renderPasswordChangedEmail } from '../emails/password-changed-email'

@requestHandler(RenderPasswordChangedEmailRequest)
export class RenderPasswordChangedEmailRequestHandler implements RequestHandler<RenderPasswordChangedEmailRequest, RenderPasswordChangedEmailRequestResult> {
  async handle(request: RenderPasswordChangedEmailRequest): Promise<RenderPasswordChangedEmailRequestResult> {
    return {
      email: await renderPasswordChangedEmail({
        userName: request.userName,
        changedAt: request.changedAt,
      }),
    }
  }
}
