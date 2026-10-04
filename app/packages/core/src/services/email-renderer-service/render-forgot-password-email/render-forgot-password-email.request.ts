import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { RenderForgotPasswordEmailRequestResult } from './render-forgot-password-email.types'

export interface RenderForgotPasswordEmailRequestData {
  userName: string | null
  code: string
  expiresInMinutes: number
}

/** Password reset code. */
export class RenderForgotPasswordEmailRequest extends RequestData<RenderForgotPasswordEmailRequestResult> {
  /** Survives build minification: RenderForgotPasswordEmailRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'RenderForgotPasswordEmailRequest'

  public readonly userName: string | null

  @hasPII(true)
  public readonly code: string

  public readonly expiresInMinutes: number

  constructor(data: RenderForgotPasswordEmailRequestData) {
    super()
    this.userName = data.userName
    this.code = data.code
    this.expiresInMinutes = data.expiresInMinutes
  }
}
