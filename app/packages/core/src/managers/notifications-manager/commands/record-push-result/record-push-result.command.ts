import { RequestData } from 'mediatr-ts'
import type { RecordPushResultCommandResult } from './record-push-result.types'

export interface RecordPushResultCommandData {
  id: string
  ok: boolean
}

export class RecordPushResultCommand extends RequestData<RecordPushResultCommandResult> {
  /** Survives build minification: RecordPushResultCommand.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'RecordPushResultCommand'

  public readonly id: string
  public readonly ok: boolean

  constructor(data: RecordPushResultCommandData) {
    super()
    this.id = data.id
    this.ok = data.ok
  }
}
