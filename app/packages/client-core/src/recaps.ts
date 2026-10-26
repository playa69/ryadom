import {
  DialogRecapApiErrorCode,
  RECAP_ABOUT_MAX,
  RECAP_AGREEMENT_MAX,
  RECAP_AGREEMENTS_MAX,
  RECAP_MAIN_MAX,
  type DialogRecapApi,
} from '@ryadom/contracts/api/dialogs'

/**
 * The recap of a conversation as the screens edit it (add-mood-diary, D13): three texts, the last one typed
 * one item per line. The same on the web and in the app, so the checks and the wording live here once.
 */

export const RECAP_LABELS = {
  about: 'О чём говорили',
  main: 'Главное',
  agreements: 'Договорились',
} as const

export const RECAP_AUTO_LABEL = 'Подводить итог автоматически'
export const RECAP_PENDING_TEXT = 'Итог появится через минуту'
export const RECAP_AGREEMENTS_HINT = `По одному пункту в строке, не больше ${RECAP_AGREEMENTS_MAX}`
export const RECAP_FIELD_LIMITS = {
  about: RECAP_ABOUT_MAX,
  main: RECAP_MAIN_MAX,
  agreement: RECAP_AGREEMENT_MAX,
  agreements: RECAP_AGREEMENTS_MAX,
} as const

export interface RecapFields {
  about: string
  main: string
  /** One agreement per line. */
  agreements: string
}

export const EMPTY_RECAP_FIELDS: RecapFields = { about: '', main: '', agreements: '' }

export function fieldsFromRecap(recap: DialogRecapApi): RecapFields {
  return { about: recap.about, main: recap.main, agreements: recap.agreements.join('\n') }
}

/** Whether the person typed anything at all: an untouched form means "write it for me". */
export function recapFieldsTouched(fields: RecapFields): boolean {
  return fields.about.trim() !== '' || fields.main.trim() !== '' || fields.agreements.trim() !== ''
}

export type RecapFieldsCheck =
  | { ok: true; recap: DialogRecapApi }
  /** `incomplete`: "what we talked about" or "the main thing" is empty; `too-many`/`too-long`: over the limits. */
  | { ok: false; reason: 'incomplete' | 'too-many' | 'too-long' }

export function recapFromFields(fields: RecapFields): RecapFieldsCheck {
  const about = fields.about.trim()
  const main = fields.main.trim()
  const agreements = fields.agreements
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (about === '' || main === '') return { ok: false, reason: 'incomplete' }
  if (agreements.length > RECAP_AGREEMENTS_MAX) return { ok: false, reason: 'too-many' }
  if (
    about.length > RECAP_ABOUT_MAX ||
    main.length > RECAP_MAIN_MAX ||
    agreements.some((item) => item.length > RECAP_AGREEMENT_MAX)
  ) {
    return { ok: false, reason: 'too-long' }
  }
  return { ok: true, recap: { about, main, agreements } }
}

export const RECAP_CHECK_TEXT: Record<'incomplete' | 'too-many' | 'too-long', string> = {
  incomplete: 'Заполни «О чём говорили» и «Главное» или оставь итог пустым: тогда я подведу его сам',
  'too-many': `Договорённостей может быть не больше ${RECAP_AGREEMENTS_MAX}`,
  'too-long': 'Один из пунктов слишком длинный: сократи его',
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
