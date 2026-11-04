import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { SendUserNotificationResult } from './send-user-notification.types'

export interface SendUserNotificationOperationData {
  /** The admin who writes it. */
  adminEmail: string
  userId: string
  title: string
  body: string
  /** A route of the app the tap opens; null for a message that only has to be read. */
  link: string | null
}

export class SendUserNotificationOperation extends RequestData<SendUserNotificationResult> {
  /** Survives minification: SendUserNotificationOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'SendUserNotificationOperation'

  @hasPII()
  public readonly adminEmail: string

  public readonly userId: string

  @hasPII(true)
  public readonly title: string

  @hasPII(true)
  public readonly body: string

  public readonly link: string | null

  constructor(data: SendUserNotificationOperationData) {
    super()
    this.adminEmail = data.adminEmail
    this.userId = data.userId
    this.title = data.title
    this.body = data.body
    this.link = data.link
  }
}
