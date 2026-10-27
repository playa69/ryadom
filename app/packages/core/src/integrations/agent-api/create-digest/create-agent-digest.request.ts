import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { CreateAgentDigestResult } from './create-agent-digest.types'

export interface AgentDigestMark {
  date: string
  mood: number
  factor: string | null
}

/** What a conversation of the week came to (its recap, add-mood-diary D13); the agent reads it with the marks. */
export interface AgentDigestRecap {
  date: string
  text: string
}

export interface CreateAgentDigestRequestData {
  userId: string
  kind: 'week'
  /** Monday of the week. */
  periodStart: string
  marks: AgentDigestMark[]
  /** Recaps of the conversations of the week; empty when there are none. */
  recaps?: AgentDigestRecap[]
}

/** The agent writes the summary text of a week; it keeps neither the request nor the answer. */
export class CreateAgentDigestRequest extends RequestData<CreateAgentDigestResult> {
  /** Survives build minification: CreateAgentDigestRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'CreateAgentDigestRequest'

  public readonly userId: string
  public readonly kind: 'week'
  public readonly periodStart: string

  /** Mood values of the person: health-adjacent, never logged. */
  @hasPII(true)
  public readonly marks: AgentDigestMark[]

  /** What the person said in conversations, summed up: personal data, never logged. */
  @hasPII(true)
  public readonly recaps: AgentDigestRecap[]

  constructor(data: CreateAgentDigestRequestData) {
    super()
    this.userId = data.userId
    this.kind = data.kind
    this.periodStart = data.periodStart
    this.marks = data.marks
    this.recaps = data.recaps ?? []
  }
}
