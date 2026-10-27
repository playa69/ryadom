import { DialogRecapApiErrorCode, RECAP_MAX } from '@ryadom/contracts/api/dialogs'

/**
 * The recap of a conversation as the screens edit it (add-mood-diary, D13): one free-form text. At the end of a
 * conversation it is the «Что забираешь с собой» field itself. The same on the web and in the app, so the checks and the
 * wording live here once.
 */

export const RECAP_TITLE = 'Итог разговора'
export const RECAP_AUTO_LABEL = 'Подводить итог автоматически'
export const RECAP_PENDING_TEXT = 'Итог появится через минуту'
export { RECAP_MAX }

export type RecapTextCheck =
  | { ok: true; recap: string }
  /** `empty`: nothing typed; `too-long`: over `RECAP_MAX`. */
  | { ok: false; reason: 'empty' | 'too-long' }

export function checkRecapText(text: string): RecapTextCheck {
  const recap = text.trim()
  if (recap === '') return { ok: false, reason: 'empty' }
  if (recap.length > RECAP_MAX) return { ok: false, reason: 'too-long' }
  return { ok: true, recap }
}

export const RECAP_CHECK_TEXT: Record<'empty' | 'too-long', string> = {
  empty: 'Напиши итог',
  'too-long': `Итог слишком длинный: не больше ${RECAP_MAX} знаков`,
}

/** What the person is told when "Pre-fill" or "Save" is refused. */
export const RECAP_ERROR_TEXT: Record<DialogRecapApiErrorCode, string> = {
  [DialogRecapApiErrorCode.USER_NOT_FOUND]: 'Не получилось. Попробуй позже',
  [DialogRecapApiErrorCode.USER_INACTIVE]: 'Не получилось. Попробуй позже',
  [DialogRecapApiErrorCode.DIALOG_NOT_FOUND]: 'Этот разговор не найден',
  [DialogRecapApiErrorCode.RECAP_NOT_AVAILABLE]: 'Для этого разговора итога не будет: в нём было слишком мало сказано',
  [DialogRecapApiErrorCode.RECAP_UNAVAILABLE]: 'Не получилось составить черновик. Можно написать итог самому',
}

/** A conversation where the person said under this many characters gets no recap (the agent decides; the screens only hint). */
export const RECAP_MIN_USER_CHARS = 40

export function saidEnoughForRecap(messages: readonly { role: string; text: string }[]): boolean {
  return messages.filter((m) => m.role === 'user').reduce((sum, m) => sum + m.text.trim().length, 0) >= RECAP_MIN_USER_CHARS
}

/**
 * Whether the journal entry offers «Написать итог»: what the agent says (it knows of a crisis), and for an agent that does
 * not say, whether the person said enough.
 */
export function canWriteRecap(
  summary: { recapAvailable?: boolean } | null,
  messages: readonly { role: string; text: string }[],
): boolean {
  return summary?.recapAvailable ?? saidEnoughForRecap(messages)
}

export const DELETE_DIALOG_CONFIRM = {
  title: 'Удалить разговор?',
  lines: [
    'Разговор удалится из журнала вместе с итогом. Факты из него останутся: удалить их можно в разделе «Память».',
    'Итоги недели, в которую он входит, пересчитаются без него.',
    'Копии в резервных архивах хранятся до 30 дней.',
  ],
  memoryLink: 'Открыть «Память»',
  confirm: 'Удалить разговор',
  cancel: 'Оставить',
} as const

export const UNSAVED_MARK_TEXT = 'Был разговор, который не сохранён по твоему желанию'
