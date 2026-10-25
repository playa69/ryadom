export interface DiaryEvent {
  id: string
  text: string
  date: string
}

export enum GetDiaryEventsOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export type GetDiaryEventsResult =
  | { success: true; memoryEnabled: boolean; events: DiaryEvent[] }
  | { success: false; error: GetDiaryEventsOperationErrorCode }
