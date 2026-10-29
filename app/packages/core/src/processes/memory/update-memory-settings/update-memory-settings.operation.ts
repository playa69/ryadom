import { RequestData } from 'mediatr-ts'
import type { UpdateMemorySettingsResult } from './update-memory-settings.types'

export interface UpdateMemorySettingsOperationData {
  userId: string
  /** The switch "Remember"; undefined changes only the switches below. */
  enabled?: boolean
  /** The switch "Remember sensitive". */
  sensitiveEnabled?: boolean
  /** The switch "Rely on past conversations". */
  chatSearchEnabled?: boolean
  /** The person accepted the memory consent sheet just now: required to turn memory on. */
  consentAccepted: boolean
  /** The version of the sheet that was on the screen, a date: required to turn memory on. */
  consentVersion: string | null
}

export class UpdateMemorySettingsOperation extends RequestData<UpdateMemorySettingsResult> {
  /** Survives minification: UpdateMemorySettingsOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'UpdateMemorySettingsOperation'

  public readonly userId: string
  public readonly enabled: boolean | undefined
  public readonly sensitiveEnabled: boolean | undefined
  public readonly chatSearchEnabled: boolean | undefined
  public readonly consentAccepted: boolean
  public readonly consentVersion: string | null

  constructor(data: UpdateMemorySettingsOperationData) {
    super()
    this.userId = data.userId
    this.enabled = data.enabled
    this.sensitiveEnabled = data.sensitiveEnabled
    this.chatSearchEnabled = data.chatSearchEnabled
    this.consentAccepted = data.consentAccepted
    this.consentVersion = data.consentVersion
  }
}
