import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { RenderWelcomeEmailRequestResult } from './render-welcome-email.types'

export interface RenderWelcomeEmailRequestData {
  userName: string | null
  code: string
  expiresInMinutes: number
}

/** Post-sign-up greeting with the email confirmation code. */
export class RenderWelcomeEmailRequest extends RequestData<RenderWelcomeEmailRequestResult> {
  /** Survives build minification: RenderWelcomeEmailRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'RenderWelcomeEmailRequest'

  public readonly userName: string | null

  @hasPII(true)
  public readonly code: string

  public readonly expiresInMinutes: number

  constructor(data: RenderWelcomeEmailRequestData) {
    super()
    this.userName = data.userName
    this.code = data.code
    this.expiresInMinutes = data.expiresInMinutes
  }
}
