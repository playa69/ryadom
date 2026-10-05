import { RequestData } from 'mediatr-ts'
import type { CreateNumericCodeRequestResult } from './create-numeric-code.types'

export type CreateNumericCodeRequestData = Record<string, never>

/**
 * A six-digit code and its SHA-256 for storage in the database. Digits only, because people type
 * it by hand from their email; the attempt limit compensates for the short alphabet.
 */
export class CreateNumericCodeRequest extends RequestData<CreateNumericCodeRequestResult> {
  /** Survives build minification: CreateNumericCodeRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'CreateNumericCodeRequest'

  constructor(_data: CreateNumericCodeRequestData = {}) {
    super()
  }
}
