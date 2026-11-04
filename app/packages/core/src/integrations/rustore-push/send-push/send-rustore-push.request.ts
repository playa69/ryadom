import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { SendRuStorePushResponse } from './send-rustore-push.types'

export interface SendRuStorePushRequestData {
  /** The push project the device's build was made for; its service token signs the request. */
  projectId: string
  /** The device's push token. */
  token: string
  title: string
  body: string
  /** Delivered to the app with the tap; values are strings, as the push service takes nothing else. */
  data: Record<string, string>
}

/** One notification to one device through RuStore Push (`POST /v1/projects/{project}/messages:send`). */
export class SendRuStorePushRequest extends RequestData<SendRuStorePushResponse> {
  /** Survives build minification: SendRuStorePushRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'SendRuStorePushRequest'

  public readonly projectId: string

  @hasPII(true)
  public readonly token: string

  @hasPII(true)
  public readonly title: string

  @hasPII(true)
  public readonly body: string

  public readonly data: Record<string, string>

  constructor(data: SendRuStorePushRequestData) {
    super()
    this.projectId = data.projectId
    this.token = data.token
    this.title = data.title
    this.body = data.body
    this.data = data.data
  }
}
