import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { SendEmailRequestResult } from './send-email.types'

export interface SendEmailRequestData {
  to: string
  subject: string
  html: string
  text: string
}

export class SendEmailRequest extends RequestData<SendEmailRequestResult> {
  /** Survives build minification: SendEmailRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'SendEmailRequest'

  @hasPII()
  public readonly to: string

  public readonly subject: string

  @hasPII(true)
  public readonly html: string

  @hasPII(true)
  public readonly text: string

  constructor(data: SendEmailRequestData) {
    super()
    this.to = data.to
    this.subject = data.subject
    this.html = data.html
    this.text = data.text
  }
}
