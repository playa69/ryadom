// 1. Handler imports
import './get-memory/get-memory.handler'
import './update-memory-settings/update-memory-settings.handler'
import './update-memory-fact/update-memory-fact.handler'
import './forget-memory-fact/forget-memory-fact.handler'
import './forget-memory/forget-memory.handler'
import './get-memory-changes/get-memory-changes.handler'
import './export-memory/export-memory.handler'
import './memory-instruction/memory-instruction.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { GetMemoryOperation } from './get-memory/get-memory.operation'
export type { GetMemoryOperationData } from './get-memory/get-memory.operation'
export { UpdateMemorySettingsOperation } from './update-memory-settings/update-memory-settings.operation'
export type { UpdateMemorySettingsOperationData } from './update-memory-settings/update-memory-settings.operation'
export { UpdateMemoryFactOperation } from './update-memory-fact/update-memory-fact.operation'
export type { UpdateMemoryFactOperationData } from './update-memory-fact/update-memory-fact.operation'
export { ForgetMemoryFactOperation } from './forget-memory-fact/forget-memory-fact.operation'
export type { ForgetMemoryFactOperationData } from './forget-memory-fact/forget-memory-fact.operation'
export { ForgetMemoryOperation } from './forget-memory/forget-memory.operation'
export type { ForgetMemoryOperationData } from './forget-memory/forget-memory.operation'
export { GetMemoryChangesOperation } from './get-memory-changes/get-memory-changes.operation'
export type { GetMemoryChangesOperationData } from './get-memory-changes/get-memory-changes.operation'
export { MemoryInstructionOperation } from './memory-instruction/memory-instruction.operation'
export type { MemoryInstructionOperationData } from './memory-instruction/memory-instruction.operation'
export { ExportMemoryOperation } from './export-memory/export-memory.operation'
export type { ExportMemoryOperationData } from './export-memory/export-memory.operation'

// 3. Type re-exports
export type { GetMemoryResult } from './get-memory/get-memory.types'
export { GetMemoryOperationErrorCode } from './get-memory/get-memory.types'
export type { UpdateMemorySettingsResult } from './update-memory-settings/update-memory-settings.types'
export { UpdateMemorySettingsOperationErrorCode } from './update-memory-settings/update-memory-settings.types'
export type { UpdateMemoryFactResult } from './update-memory-fact/update-memory-fact.types'
export { UpdateMemoryFactOperationErrorCode } from './update-memory-fact/update-memory-fact.types'
export type { ForgetMemoryFactResult } from './forget-memory-fact/forget-memory-fact.types'
export { ForgetMemoryFactOperationErrorCode } from './forget-memory-fact/forget-memory-fact.types'
export type { ForgetMemoryResult } from './forget-memory/forget-memory.types'
export { ForgetMemoryOperationErrorCode } from './forget-memory/forget-memory.types'
export type { GetMemoryChangesResult } from './get-memory-changes/get-memory-changes.types'
export { GetMemoryChangesOperationErrorCode } from './get-memory-changes/get-memory-changes.types'
export type {
  MemoryInstructionChangesDTO,
  MemoryInstructionResult,
} from './memory-instruction/memory-instruction.types'
export { MemoryInstructionOperationErrorCode } from './memory-instruction/memory-instruction.types'
export type { ExportMemoryResult } from './export-memory/export-memory.types'
export { ExportMemoryOperationErrorCode } from './export-memory/export-memory.types'
export type {
  MemoryChangeDTO,
  MemoryChangesDTO,
  MemoryDTO,
  MemoryEventDTO,
  MemoryExportDTO,
  MemoryFactDTO,
  MemoryNoteDTO,
  MemoryFactSlotsDTO,
  MemoryFactSourceDTO,
  MemorySettingsDTO,
} from './shared/memory.dto'

// 4. Union type
import type { GetMemoryOperation } from './get-memory/get-memory.operation'
import type { UpdateMemorySettingsOperation } from './update-memory-settings/update-memory-settings.operation'
import type { UpdateMemoryFactOperation } from './update-memory-fact/update-memory-fact.operation'
import type { ForgetMemoryFactOperation } from './forget-memory-fact/forget-memory-fact.operation'
import type { ForgetMemoryOperation } from './forget-memory/forget-memory.operation'
import type { GetMemoryChangesOperation } from './get-memory-changes/get-memory-changes.operation'
import type { ExportMemoryOperation } from './export-memory/export-memory.operation'
import type { MemoryInstructionOperation } from './memory-instruction/memory-instruction.operation'

export type MemoryOperations =
  | GetMemoryOperation
  | UpdateMemorySettingsOperation
  | UpdateMemoryFactOperation
  | ForgetMemoryFactOperation
  | ForgetMemoryOperation
  | GetMemoryChangesOperation
  | ExportMemoryOperation
  | MemoryInstructionOperation

// 5. Facade
export class MemoryProcess implements IMemoryProcess {
  async execute<T extends MemoryOperations>(request: T): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: MemoryOperations) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IMemoryProcess {
  execute<T extends MemoryOperations>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const memoryProcess: IMemoryProcess = new MemoryProcess()
