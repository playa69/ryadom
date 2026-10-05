import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { HashTokenRequest } from './hash-token.request'
import type { HashTokenRequestResult } from './hash-token.types'
import { sha256Hex } from '../config'

@requestHandler(HashTokenRequest)
export class HashTokenRequestHandler implements RequestHandler<HashTokenRequest, HashTokenRequestResult> {
  async handle(request: HashTokenRequest): Promise<HashTokenRequestResult> {
    return { tokenHash: sha256Hex(request.token) }
  }
}
