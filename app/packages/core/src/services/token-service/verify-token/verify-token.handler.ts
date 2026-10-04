import { timingSafeEqual } from 'node:crypto'
import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { VerifyTokenRequest } from './verify-token.request'
import type { VerifyTokenRequestResult } from './verify-token.types'
import { sha256Hex } from '../config'

/**
 * Whether a token matches the hash that was stored for it. Compared in constant time: the answer
 * must not depend on how many leading characters of the hash were right.
 */
@requestHandler(VerifyTokenRequest)
export class VerifyTokenRequestHandler implements RequestHandler<
  VerifyTokenRequest,
  VerifyTokenRequestResult
> {
  async handle(request: VerifyTokenRequest): Promise<VerifyTokenRequestResult> {
    const actual = Buffer.from(sha256Hex(request.token))
    const expected = Buffer.from(request.tokenHash)
    return { isValid: actual.length === expected.length && timingSafeEqual(actual, expected) }
  }
}
