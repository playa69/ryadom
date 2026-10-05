// 1. Handler imports
import './render-welcome-email/render-welcome-email.handler'
import './render-email-confirmation-email/render-email-confirmation-email.handler'
import './render-forgot-password-email/render-forgot-password-email.handler'
import './render-password-changed-email/render-password-changed-email.handler'
import './render-admin-code-email/render-admin-code-email.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { RenderWelcomeEmailRequest } from './render-welcome-email/render-welcome-email.request'
export type { RenderWelcomeEmailRequestData } from './render-welcome-email/render-welcome-email.request'
export { RenderEmailConfirmationEmailRequest } from './render-email-confirmation-email/render-email-confirmation-email.request'
export type { RenderEmailConfirmationEmailRequestData } from './render-email-confirmation-email/render-email-confirmation-email.request'
export { RenderForgotPasswordEmailRequest } from './render-forgot-password-email/render-forgot-password-email.request'
export type { RenderForgotPasswordEmailRequestData } from './render-forgot-password-email/render-forgot-password-email.request'
export { RenderPasswordChangedEmailRequest } from './render-password-changed-email/render-password-changed-email.request'
export type { RenderPasswordChangedEmailRequestData } from './render-password-changed-email/render-password-changed-email.request'
export { RenderAdminCodeEmailRequest } from './render-admin-code-email/render-admin-code-email.request'
export type { RenderAdminCodeEmailRequestData } from './render-admin-code-email/render-admin-code-email.request'

// 3. Type re-exports
export type { RenderWelcomeEmailRequestResult } from './render-welcome-email/render-welcome-email.types'
export type { RenderEmailConfirmationEmailRequestResult } from './render-email-confirmation-email/render-email-confirmation-email.types'
export type { RenderForgotPasswordEmailRequestResult } from './render-forgot-password-email/render-forgot-password-email.types'
export type { RenderPasswordChangedEmailRequestResult } from './render-password-changed-email/render-password-changed-email.types'
export type { RenderAdminCodeEmailRequestResult } from './render-admin-code-email/render-admin-code-email.types'
export type { RenderedEmail } from './shared/rendered-email'

// 4. Union type
import type { RenderWelcomeEmailRequest } from './render-welcome-email/render-welcome-email.request'
import type { RenderEmailConfirmationEmailRequest } from './render-email-confirmation-email/render-email-confirmation-email.request'
import type { RenderForgotPasswordEmailRequest } from './render-forgot-password-email/render-forgot-password-email.request'
import type { RenderPasswordChangedEmailRequest } from './render-password-changed-email/render-password-changed-email.request'
import type { RenderAdminCodeEmailRequest } from './render-admin-code-email/render-admin-code-email.request'

export type EmailRendererServiceRequests =
  | RenderWelcomeEmailRequest
  | RenderEmailConfirmationEmailRequest
  | RenderForgotPasswordEmailRequest
  | RenderPasswordChangedEmailRequest
  | RenderAdminCodeEmailRequest

// 5. Facade
export class EmailRendererService implements IEmailRendererService {
  async execute<T extends EmailRendererServiceRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: EmailRendererServiceRequests) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IEmailRendererService {
  execute<T extends EmailRendererServiceRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never>
}

export const emailRendererService: IEmailRendererService = new EmailRendererService()
