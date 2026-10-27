import { RequestData } from 'mediatr-ts'
import type { UpdateAgentMemorySettingsResult } from './update-agent-memory-settings.types'

export interface UpdateAgentMemorySettingsRequestData {
  userId: string
  /** Undefined changes only the switches below. */
  enabled?: boolean
  sensitiveEnabled?: boolean
  chatSearchEnabled?: boolean
  /** The version of the consent sheet the person accepted: required to turn memory on, null to turn it off. */
  consentVersion: string | null
}

/** The person's own switch "Remember". */
export class UpdateAgentMemorySettingsRequest extends RequestData<UpdateAgentMemorySettingsResult> {
  /** Survives build minification: UpdateAgentMemorySettingsRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'UpdateAgentMemorySettingsRequest'

  public readonly userId: string
  public readonly enabled: boolean | undefined
  public readonly sensitiveEnabled: boolean | undefined
  public readonly chatSearchEnabled: boolean | undefined
  public readonly consentVersion: string | null

  constructor(data: UpdateAgentMemorySettingsRequestData) {
    super()
    this.userId = data.userId
    this.enabled = data.enabled
    this.sensitiveEnabled = data.sensitiveEnabled
    this.chatSearchEnabled = data.chatSearchEnabled
    this.consentVersion = data.consentVersion
  }
}
