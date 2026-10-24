import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { CreateAgentDigestResult } from './create-agent-digest.types'

export interface AgentDigestMark {
  date: string
  mood: number
  factor: string | null
}

export interface CreateAgentDigestRequestData {
  userId: string
  kind: 'week' | 'year'
  /** Monday of the week, or 1 January of the year. */
  periodStart: string
  marks: AgentDigestMark[]
  /** For the year: the texts of the week summaries already made. */
  weekly?: string[]
}

/** The agent writes the summary text of a week or a year; it keeps neither the request nor the answer. */
export class CreateAgentDigestRequest extends RequestData<CreateAgentDigestResult> {
  /** Survives build minification: CreateAgentDigestRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'CreateAgentDigestRequest'

  public readonly userId: string
  public readonly kind: 'week' | 'year'
  public readonly periodStart: string

  /** Mood values of the person: health-adjacent, never logged. */
  @hasPII(true)
  public readonly marks: AgentDigestMark[]

  @hasPII(true)
  public readonly weekly: string[]

  constructor(data: CreateAgentDigestRequestData) {
    super()
    this.userId = data.userId
    this.kind = data.kind
    this.periodStart = data.periodStart
    this.marks = data.marks
    this.weekly = data.weekly ?? []
  }
}
