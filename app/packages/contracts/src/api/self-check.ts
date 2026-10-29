/**
 * Tests inside the app (`REQ-WELL-06`…`08`, `openspec/specs/self-check`). A result is saved only after the
 * person agreed (`SelfCheckApiErrorCode.CONSENT_REQUIRED`); the server recomputes the score from the answers with the
 * same package as the clients and keeps the score, the subscores, the level and the time, never the answers.
 * A result is a fact about health: it goes to the person's own screens only, never to the agent and never to analytics.
 */

/** The version of the consent text shown on the sheet «Сохранить результаты?». */
export const SELF_CHECK_CONSENT_VERSION = '2026-10-27'

export enum SelfCheckApiErrorCode {
  /** The person has not agreed to keep results yet: show the consent sheet, then try again. */
  CONSENT_REQUIRED = 'CONSENT_REQUIRED',
}

export interface SelfCheckSubscaleApi {
  id: string
  label: string
  score: number
}

export interface SelfCheckResultApi {
  id: string
  testId: string
  testVersion: number
  score: number
  subscores: SelfCheckSubscaleApi[] | null
  /** The label of the level at the time of saving, as the screen showed it. */
  band: string
  /** ISO time of the pass. */
  takenAt: string
}

export interface SaveSelfCheckApiRequest {
  testId: string
  testVersion: number
  /** The values of the options in the order of the questions. Used for the recount and not stored. */
  answers: number[]
  takenAt?: string
}

export interface SelfCheckResultsApiResponse {
  items: SelfCheckResultApi[]
  /** `takenAt` to pass as `before` for the next page, or null at the end. */
  nextBefore: string | null
}

export interface SelfCheckLatestApiResponse {
  /** The newest result of every test that has one. */
  items: SelfCheckResultApi[]
}

export interface SelfCheckConsentApiResponse {
  given: boolean
  version: string | null
}

export interface DeleteSelfCheckApiResponse {
  deleted: number
}
