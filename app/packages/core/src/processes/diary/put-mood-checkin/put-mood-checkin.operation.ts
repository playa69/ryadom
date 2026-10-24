import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { MoodFactor, MoodSource } from '@ryadom/db/schema'
import type { PutMoodCheckinResult } from './put-mood-checkin.types'

export interface PutMoodCheckinOperationData {
  userId: string
  mood: number
  factor?: MoodFactor | null
  date?: string
  source: MoodSource
  now?: Date
}

export class PutMoodCheckinOperation extends RequestData<PutMoodCheckinResult> {
  /** Survives build minification: PutMoodCheckinOperation.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'PutMoodCheckinOperation'

  public readonly userId: string
  @hasPII(true)
  public readonly mood: number
  @hasPII(true)
  public readonly factor?: MoodFactor | null
  public readonly date?: string
  public readonly source: MoodSource
  public readonly now?: Date

  constructor(data: PutMoodCheckinOperationData) {
    super()
    this.userId = data.userId
    this.mood = data.mood
    this.factor = data.factor
    this.date = data.date
    this.source = data.source
    this.now = data.now
  }
}
