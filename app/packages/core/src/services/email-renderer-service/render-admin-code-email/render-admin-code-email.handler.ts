import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { renderAdminCodeEmail } from '../emails/admin-code-email'
import { RenderAdminCodeEmailRequest } from './render-admin-code-email.request'
import type { RenderAdminCodeEmailRequestResult } from './render-admin-code-email.types'

@requestHandler(RenderAdminCodeEmailRequest)
export class RenderAdminCodeEmailRequestHandler
  implements RequestHandler<RenderAdminCodeEmailRequest, RenderAdminCodeEmailRequestResult>
{
  async handle(request: RenderAdminCodeEmailRequest): Promise<RenderAdminCodeEmailRequestResult> {
    const email = await renderAdminCodeEmail({
      code: request.code,
      expiresInMinutes: request.expiresInMinutes,
    })
    return { email }
  }
}
