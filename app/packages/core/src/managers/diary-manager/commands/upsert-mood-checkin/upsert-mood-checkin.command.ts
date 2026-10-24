import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../../shared'
import type { MoodFactor, MoodSource } from '@ryadom/db/schema'
import type { UpsertMoodCheckinCommandResult } from './upsert-mood-checkin.types'

export interface UpsertMoodCheckinCommandData {
  userId: string
  localDate: string
  mood: number
  factor?: MoodFactor | null
  source: MoodSource
}

export class UpsertMoodCheckinCommand extends RequestData<UpsertMoodCheckinCommandResult> {
  /** Survives build minification: UpsertMoodCheckinCommand.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'UpsertMoodCheckinCommand'

  public readonly userId: string
  public readonly localDate: string
  @hasPII(true)
  public readonly mood: number
  @hasPII(true)
  public readonly factor?: MoodFactor | null
  public readonly source: MoodSource

  constructor(data: UpsertMoodCheckinCommandData) {
    super()
    this.userId = data.userId
    this.localDate = data.localDate
    this.mood = data.mood
    this.factor = data.factor
    this.source = data.source
  }
}
