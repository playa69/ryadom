export enum CreateAgentDigestRequestErrorCode {
  /** The agent answered, but could not write a text (the model failed or refused). */
  UNAVAILABLE = 'UNAVAILABLE',
}

export type CreateAgentDigestResult =
  | { success: true; text: string; stats: Record<string, unknown> | null }
  | { success: false; error: CreateAgentDigestRequestErrorCode }
