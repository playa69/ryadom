import { randomInt } from 'node:crypto'
import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { CreateNumericCodeRequest } from './create-numeric-code.request'
import type { CreateNumericCodeRequestResult } from './create-numeric-code.types'
import { sha256Hex, tokenConfig } from '../config'

@requestHandler(CreateNumericCodeRequest)
export class CreateNumericCodeRequestHandler
  implements RequestHandler<CreateNumericCodeRequest, CreateNumericCodeRequestResult>
{
  async handle(): Promise<CreateNumericCodeRequestResult> {
    const code = String(randomInt(0, 10 ** tokenConfig.numericCodeDigits)).padStart(
      tokenConfig.numericCodeDigits,
      '0',
    )
    return { code, codeHash: sha256Hex(code) }
  }
}
