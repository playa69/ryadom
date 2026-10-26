import {
  CreateMemoryFactApiErrorCode,
  ForgetMemoryApiErrorCode,
  MEMORY_CONSENT_VERSION,
  MemoryChangeOp,
  MemoryChangesStatus,
  MemoryFactCategory,
  MemoryFactOrigin,
  MemoryFactStatus,
  MemoryServiceMode,
  UpdateMemoryFactApiErrorCode,
  UpdateMemorySettingsApiErrorCode,
  type MemoryApiResponse,
  type MemoryChangesApiResponse,
  type MemoryExportApiResponse,
  type MemoryFactApiResponse,
  type MemoryPersonSlots,
  type MemoryStyleSlots,
  type UpdateMemoryFactApiRequest,
} from '@ryadom/contracts/api/memory'
import { InputLimit } from '@ryadom/contracts/api/limits'
import type { ApiOutcome } from './errors'

/**
 * Memory on the client, shared by the phone and the browser: the consent sheet, how the screen
 * "Память" groups and labels what is remembered, which actions a fact has, the card "Я запомнил"
 * after a conversation (whether to show it, and the polling behind it), and the delayed "forget"
 * with its five seconds to take it back.
 *
 * The texts of the facts are the person's own words. Nothing here logs them, stores them or passes
 * them anywhere but back to the screen; the apps must do the same (no analytics, no storage).
 */

// ─── consent ──────────────────────────────────────────────────────────────────

/**
 * The consent sheet "Память": a separate document, not a clause of the terms. Its version is
 * `MEMORY_CONSENT_VERSION` (the date in the contract): a new text means a new date, and the sheet is
 * shown again the next time the person turns memory on.
 *
 * DRAFT (spec appendix C). The final wording, the form of the consent and the sentence about the
 * transfer of the summary abroad are for the lawyer and the psychologist; change the date in the
 * contract together with the text.
 */
export const MEMORY_CONSENT = {
  version: MEMORY_CONSENT_VERSION,
  title: 'Память',
  paragraphs: [
    'Если включить память, я буду помнить важное из наших разговоров, чтобы не начинать каждый раз с нуля: кто тебе близок, что сейчас происходит, что тебе помогает и как с тобой лучше говорить.',
    'Я не запоминаю диагнозы и лекарства, подробности тяжёлых моментов, чужие телефоны и адреса.',
    'Всё, что я запомнил, ты видишь в «Профиль → Память»: можно исправить, закрепить или забыть. Любой разговор можно провести «Без памяти». Выключить память или забыть всё можно в любой момент.',
    'Запомненное хранится в России. Короткая выжимка передаётся модели, которая со мной разговаривает, чтобы я мог ею пользоваться.',
    'Память можно не включать: всё остальное в «Рядом» работает так же.',
    'Я ИИ, а не человек и не врач.',
  ],
  accept: 'Включить память',
  decline: 'Не сейчас',
} as const

/** "Как это работает": the consent text and what the screen itself does with the facts. */
export const MEMORY_HOW_IT_WORKS: readonly string[] = [
  ...MEMORY_CONSENT.paragraphs.slice(0, 4),
  'После разговора я показываю, что запомнил: лишнее можно сразу убрать. Важное и личное я сначала спрашиваю — такие пункты ждут твоего «Запомнить».',
  'Закреплённое и исправленное тобой я сам не меняю. Предположения я не использую, пока ты их не подтвердишь или они не повторятся в другом разговоре.',
  'Разговор «Без памяти» я не запоминаю, а сам он удаляется через сутки после последнего сообщения.',
]

/** Turning memory on shows the sheet first unless the person has accepted this very text before. */
export function needsMemoryConsent(memory: Pick<MemoryApiResponse, 'consentVersion'> | null): boolean {
  return memory?.consentVersion !== MEMORY_CONSENT_VERSION
}

// ─── whether to offer memory at all ───────────────────────────────────────────

/**
 * Whether the profile has the section "Память" (and its screen shows more than "not yet"). The apps
 * ship before the feature is switched on: while the server keeps it off, a person who has nothing
 * there must not meet a section that only says "unavailable". Someone who has turned it on or has
 * facts keeps the section (with "Недоступно сейчас", "Забыть всё" and the download). Null (the
 * request failed) shows nothing.
 */
export function shouldShowMemorySection(
  memory: Pick<MemoryApiResponse, 'mode' | 'enabled' | 'facts'> | null,
): boolean {
  if (!memory) return false
  return memory.mode !== MemoryServiceMode.Off || memory.enabled || memory.facts.length > 0
}

/**
 * Whether memory is at work for the person right now: their switch is on and the server uses it.
 * Home offers "Без памяти" only then; with the feature off on the server there is nothing to hold back.
 */
export function memoryInUse(memory: Pick<MemoryApiResponse, 'mode' | 'enabled' | 'available'>): boolean {
  return memory.enabled && memory.available && memory.mode !== MemoryServiceMode.Off
}

/** The quiet word beside the section's row in the profile. */
export function memorySectionStatus(memory: Pick<MemoryApiResponse, 'enabled' | 'available'>): string {
  if (!memory.available) return 'недоступна'
  return memory.enabled ? 'включена' : 'выключена'
}

/** The mark of a conversation held "without memory" in the journal; null for any other. */
export function dialogMemoryMark(dialog: {
  memoryMode?: string | null
}): { label: string; hint: string } | null {
  return dialog.memoryMode === 'off'
    ? { label: 'Без памяти', hint: 'Удалится через сутки после последнего сообщения' }
    : null
}

// ─── the screen "Память" ──────────────────────────────────────────────────────

export type MemoryGroupId =
  'style' | 'people' | 'now' | 'helps' | 'interests' | 'boundaries' | 'recap' | 'other' | 'guesses'

export interface MemoryGroup {
  id: MemoryGroupId
  title: string
  facts: MemoryFactApiResponse[]
}

const GROUPS: Array<{ id: MemoryGroupId; title: string; categories: MemoryFactCategory[] }> = [
  { id: 'style', title: 'Как со мной говорить', categories: [MemoryFactCategory.Style] },
  { id: 'people', title: 'Близкие', categories: [MemoryFactCategory.Person] },
  { id: 'now', title: 'Что сейчас', categories: [MemoryFactCategory.Situation, MemoryFactCategory.Goal] },
  { id: 'helps', title: 'Что помогает', categories: [MemoryFactCategory.Works] },
  { id: 'interests', title: 'Интересы', categories: [MemoryFactCategory.Interest] },
  { id: 'boundaries', title: 'Границы', categories: [MemoryFactCategory.Boundary] },
  { id: 'recap', title: 'Прошлый разговор', categories: [MemoryFactCategory.Recap] },
]

export interface MemoryView {
  /** Waiting for the person's "Запомнить": shown first and apart, they are not used until then. */
  proposed: MemoryFactApiResponse[]
  /** Non-empty groups in screen order; guesses (`candidate`) come last, whatever their category. */
  groups: MemoryGroup[]
  /** How many facts the screen shows: expired ones are not among them. */
  count: number
}

/**
 * The facts as the screen shows them. The server's order (category, then weight) is kept inside a
 * group. A category this client does not know yet (a newer server) still shows, under "Другое": a
 * person must be able to see and forget everything that is remembered.
 */
export function groupMemory(facts: readonly MemoryFactApiResponse[]): MemoryView {
  const visible = facts.filter((fact) => fact.status !== MemoryFactStatus.Expired)
  const proposed = visible.filter((fact) => fact.status === MemoryFactStatus.Proposed)
  const guesses = visible.filter((fact) => fact.status === MemoryFactStatus.Candidate)
  const settled = visible.filter(
    (fact) => fact.status !== MemoryFactStatus.Proposed && fact.status !== MemoryFactStatus.Candidate,
  )
  const known = new Set<string>(GROUPS.flatMap((group) => group.categories))

  const groups: MemoryGroup[] = GROUPS.map(({ id, title, categories }) => ({
    id,
    title,
    facts: settled.filter((fact) => categories.includes(fact.category)),
  }))
  groups.push({ id: 'other', title: 'Другое', facts: settled.filter((fact) => !known.has(fact.category)) })
  groups.push({ id: 'guesses', title: 'Предположения', facts: guesses })

  return { proposed, groups: groups.filter((group) => group.facts.length > 0), count: visible.length }
}

const DAY_SHORT = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' })
const DAY_SHORT_YEAR = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })

/** `YYYY-MM-DD` as a local calendar day: parsed as UTC it would be the day before west of Greenwich. */
function parseDay(day: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(day)
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? null : date
}

/** "12 окт.", with the year when it is not this one. */
export function memoryDay(day: string, now: Date = new Date()): string {
  const date = parseDay(day)
  if (!date) return ''
  return date.getFullYear() === now.getFullYear() ? DAY_SHORT.format(date) : DAY_SHORT_YEAR.format(date)
}

/** "из 2 разговоров", "из 21 разговора": the genitive after «из». */
function conversationsGenitive(count: number): string {
  const last = count % 10
  const lastTwo = count % 100
  return last === 1 && lastTwo !== 11 ? 'разговора' : 'разговоров'
}

/**
 * Where a fact came from, under its text: "из разговора 12 окт.", "из 3 разговоров, последний 12 окт.",
 * "записано тобой" for one the person wrote and that no conversation backs. Empty when nothing is known.
 */
export function memoryFactSource(
  fact: Pick<MemoryFactApiResponse, 'sources' | 'origin'>,
  now: Date = new Date(),
): string {
  const days = fact.sources
    .map((source) => source.date)
    .filter((day) => parseDay(day) !== null)
    .sort()
  const latest = days[days.length - 1]
  if (!latest) return fact.origin === MemoryFactOrigin.UserEdit ? 'записано тобой' : ''
  const dialogs = new Set(fact.sources.map((source) => source.dialogId)).size
  if (dialogs <= 1) return `из разговора ${memoryDay(latest, now)}`
  return `из ${dialogs} ${conversationsGenitive(dialogs)}, последний ${memoryDay(latest, now)}`
}

/** A short mark beside the source for a fact that is not simply active. */
export function memoryFactBadge(fact: Pick<MemoryFactApiResponse, 'status'>): string | null {
  switch (fact.status) {
    case MemoryFactStatus.Pinned:
      return 'Закреплено'
    case MemoryFactStatus.Proposed:
      return 'Ждёт ответа'
    case MemoryFactStatus.Candidate:
      return 'Предположение'
    default:
      return null
  }
}

/**
 * What can be done with a fact; the names are those of the analytics event `memory_fact_action`.
 * `delete` is "Забыть" (and "Не запоминать" is `decline`): both forget the fact for good.
 */
export type MemoryFactAction = 'edit' | 'pin' | 'unpin' | 'delete' | 'confirm' | 'accept' | 'decline'

export function memoryFactActions(fact: Pick<MemoryFactApiResponse, 'status'>): MemoryFactAction[] {
  switch (fact.status) {
    case MemoryFactStatus.Proposed:
      return ['accept', 'decline']
    case MemoryFactStatus.Candidate:
      return ['confirm', 'edit', 'delete']
    case MemoryFactStatus.Pinned:
      return ['edit', 'unpin', 'delete']
    case MemoryFactStatus.Active:
      return ['edit', 'pin', 'delete']
    default:
      return []
  }
}

/** The words on the buttons. */
export const MEMORY_ACTION_LABEL: Record<MemoryFactAction, string> = {
  edit: 'Исправить',
  pin: 'Закрепить',
  unpin: 'Открепить',
  delete: 'Забыть',
  confirm: 'Верно',
  accept: 'Запомнить',
  decline: 'Не запоминать',
}

/** The request behind an action that is a PATCH; `edit` carries the new text, the forgetting ones are a DELETE. */
export function memoryFactChange(action: 'pin' | 'unpin' | 'accept' | 'confirm'): UpdateMemoryFactApiRequest {
  switch (action) {
    case 'pin':
      return { status: MemoryFactStatus.Pinned }
    case 'unpin':
    case 'accept':
      return { status: MemoryFactStatus.Active }
    case 'confirm':
      return { confirm: true }
  }
}

/** Puts a fact the server returned in place of the old one, keeping the order of the screen. */
export function replaceMemoryFact(
  facts: readonly MemoryFactApiResponse[],
  fact: MemoryFactApiResponse,
): MemoryFactApiResponse[] {
  return facts.map((item) => (item.id === fact.id ? fact : item))
}

// ─── editing ──────────────────────────────────────────────────────────────────

/**
 * How long a fact written as text may be: from `InputLimit.MemoryFactMin` up to the agent's limit for
 * the category (spec 6.1), never above `InputLimit.MemoryFactMax`. The server checks it anyway; the
 * field checks it first so that a short or long text is not refused as "cannot remember this". Facts
 * built from fields (style, person) have no minimum.
 */
export const MEMORY_TEXT_MIN: number = InputLimit.MemoryFactMin
const MEMORY_TEXT_MAX: Partial<Record<MemoryFactCategory, number>> = {
  [MemoryFactCategory.Boundary]: 120,
  [MemoryFactCategory.Situation]: 160,
  [MemoryFactCategory.Goal]: 160,
  [MemoryFactCategory.Works]: 160,
  [MemoryFactCategory.Interest]: 120,
}

export function memoryTextMax(category: MemoryFactCategory): number {
  return Math.min(MEMORY_TEXT_MAX[category] ?? InputLimit.MemoryFactMax, InputLimit.MemoryFactMax)
}

/** A phrase for a text the person typed, or null when it may go to the server. */
export function memoryTextProblem(text: string, category: MemoryFactCategory): string | null {
  const length = text.trim().length
  if (length === 0) return 'Напиши, что запомнить'
  if (length < MEMORY_TEXT_MIN) return `Чуть подробнее: хотя бы ${MEMORY_TEXT_MIN} знаков`
  const max = memoryTextMax(category)
  if (length > max) return `Не длиннее ${max} знаков`
  return null
}

/** The fields of "how to talk to me": a fact of this category is built from them, never written as text. */
export const STYLE_SLOTS = {
  form: {
    label: 'Обращение',
    options: [
      { value: 'ty', label: 'на «ты»' },
      { value: 'vy', label: 'на «вы»' },
    ],
  },
  length: {
    label: 'Ответы',
    options: [
      { value: 'short', label: 'покороче' },
      { value: 'normal', label: 'как обычно' },
    ],
  },
  advice: {
    label: 'Советы',
    options: [
      { value: 'ask_first', label: 'сначала спросить' },
      { value: 'ok', label: 'можно сразу' },
    ],
  },
  tone: {
    label: 'Тон',
    options: [
      { value: 'soft', label: 'мягче' },
      { value: 'direct', label: 'прямее' },
    ],
  },
} as const

export type StyleChoiceSlot = keyof typeof STYLE_SLOTS

export const STYLE_ADDRESS_LABEL = 'Как к тебе обращаться'
export const STYLE_ADDRESS_MAX = 30

/** The slots with empty fields dropped and the name trimmed: what goes to the server. */
export function cleanStyleSlots(slots: MemoryStyleSlots): MemoryStyleSlots {
  const clean: MemoryStyleSlots = {}
  const address = slots.address?.trim()
  if (address) clean.address = address
  if (slots.form) clean.form = slots.form
  if (slots.length) clean.length = slots.length
  if (slots.advice) clean.advice = slots.advice
  if (slots.tone) clean.tone = slots.tone
  return clean
}

/** The server's rule for the name (no digits, no links, up to 30) and "at least one field". */
export function styleSlotsProblem(slots: MemoryStyleSlots): string | null {
  const clean = cleanStyleSlots(slots)
  if (Object.keys(clean).length === 0) return 'Выбери хотя бы что-нибудь одно'
  if (clean.address !== undefined) {
    if (clean.address.length > STYLE_ADDRESS_MAX) return `Имя — не длиннее ${STYLE_ADDRESS_MAX} знаков`
    if (/\d|https?:|www\.|@/i.test(clean.address)) return 'Только имя, без цифр и ссылок'
  }
  return null
}

/**
 * A close person is three fields too, and the server writes the text from them ("Сестра Аня:
 * поддерживает"). The role comes from the server's dictionary; these are the ones offered for a
 * choice. A role this list lacks (one the server took from a conversation) is kept as it is.
 */
export const PERSON_ROLES: readonly string[] = [
  'мама',
  'папа',
  'сестра',
  'брат',
  'бабушка',
  'дедушка',
  'муж',
  'жена',
  'партнёр',
  'парень',
  'девушка',
  'друг',
  'подруга',
  'сын',
  'дочь',
  'ребёнок',
  'коллега',
  'начальник',
]

export const PERSON_SLOT_LABELS = { role: 'Кто это', name: 'Имя', note: 'Пара слов' } as const
export const PERSON_NAME_MAX = 20
export const PERSON_NOTE_MAX = 60

/** The person's fields as the server takes them: trimmed, empty ones dropped, the name capitalised. */
export function cleanPersonSlots(slots: Partial<MemoryPersonSlots>): MemoryPersonSlots {
  const clean: MemoryPersonSlots = { role: slots.role?.trim().toLowerCase() ?? '' }
  const name = slots.name?.trim()
  if (name) clean.name = name.charAt(0).toUpperCase() + name.slice(1)
  const note = slots.note?.trim()
  if (note) clean.note = note
  return clean
}

/** The server's rules: a role; the name one word of letters up to 20; the note up to 60. */
export function personSlotsProblem(slots: Partial<MemoryPersonSlots>): string | null {
  const clean = cleanPersonSlots(slots)
  if (!clean.role) return 'Выбери, кто это'
  if (clean.name !== undefined) {
    if (clean.name.length > PERSON_NAME_MAX) return `Имя — не длиннее ${PERSON_NAME_MAX} знаков`
    if (!/^[\p{L}-]+$/u.test(clean.name)) return 'Только имя, одним словом'
  }
  if (clean.note !== undefined && clean.note.length > PERSON_NOTE_MAX)
    return `Не длиннее ${PERSON_NOTE_MAX} знаков`
  return null
}

/** What the person can write down themselves, in the words of the form "Добавить". */
export const MEMORY_CATEGORY_LABEL: Record<MemoryFactCategory, string> = {
  [MemoryFactCategory.Style]: 'Как со мной говорить',
  [MemoryFactCategory.Person]: 'Близкий человек',
  [MemoryFactCategory.Situation]: 'Что сейчас происходит',
  [MemoryFactCategory.Goal]: 'Планы и цели',
  [MemoryFactCategory.Works]: 'Что помогает',
  [MemoryFactCategory.Interest]: 'Интересы и приятное',
  [MemoryFactCategory.Boundary]: 'О чём не говорить',
  [MemoryFactCategory.Recap]: 'Прошлый разговор',
}

/** Under the form of a correction or a new fact. */
export const MEMORY_FORM_NOTE =
  'Записанное тобой я закреплю и сам менять не буду. Кое-что я запомнить не могу: например, телефоны и адреса.'

/** A hint inside the empty text field. */
export const MEMORY_TEXT_PLACEHOLDER: Partial<Record<MemoryFactCategory, string>> = {
  [MemoryFactCategory.Situation]: 'Например: ищу работу после переезда',
  [MemoryFactCategory.Goal]: 'Например: готовлюсь к экзамену в ноябре',
  [MemoryFactCategory.Works]: 'Например: помогают вечерние прогулки',
  [MemoryFactCategory.Interest]: 'Например: люблю джаз, у меня собака',
  [MemoryFactCategory.Boundary]: 'Например: не спрашивать про работу',
}

/**
 * The categories the form "Добавить" offers. A retelling is the agent's own, not the person's to write;
 * "how to talk to me" is one fact per person, so while there is one it is corrected, not added again.
 */
export function newMemoryFactCategories(facts: readonly MemoryFactApiResponse[]): MemoryFactCategory[] {
  const hasStyle = facts.some(
    (fact) => fact.category === MemoryFactCategory.Style && fact.status !== MemoryFactStatus.Expired,
  )
  return [
    MemoryFactCategory.Style,
    MemoryFactCategory.Person,
    MemoryFactCategory.Situation,
    MemoryFactCategory.Goal,
    MemoryFactCategory.Works,
    MemoryFactCategory.Interest,
    MemoryFactCategory.Boundary,
  ].filter((category) => category !== MemoryFactCategory.Style || !hasStyle)
}

/** Which form a correction takes: the server builds `style` and `person` from fields, the rest is text. */
export function memoryEditKind(category: MemoryFactCategory): 'style' | 'person' | 'text' {
  if (category === MemoryFactCategory.Style) return 'style'
  if (category === MemoryFactCategory.Person) return 'person'
  return 'text'
}

/** What the form holds while the person fills it in; only the part for the category is sent. */
export interface MemoryFactDraft {
  text: string
  style: MemoryStyleSlots
  person: Partial<MemoryPersonSlots>
}

/** The form for a fact: empty for a new one, its fields or its text for a correction. */
export function memoryFactDraft(fact: MemoryFactApiResponse | null): MemoryFactDraft {
  if (!fact) return { text: '', style: {}, person: {} }
  const kind = memoryEditKind(fact.category)
  return {
    text: kind === 'text' ? fact.text : '',
    style: kind === 'style' ? { ...((fact.slots ?? {}) as MemoryStyleSlots) } : {},
    person: kind === 'person' ? { ...((fact.slots ?? {}) as MemoryPersonSlots) } : {},
  }
}

/**
 * The checked body of a correction or a new fact: `{ body }` to send, or `{ problem }` to show under
 * the form. `style` and `person` send only their fields, the rest only the text (the contract).
 */
export function memoryFactBody(
  category: MemoryFactCategory,
  draft: MemoryFactDraft,
): { body: { text: string } | { slots: MemoryStyleSlots | MemoryPersonSlots } } | { problem: string } {
  const kind = memoryEditKind(category)
  if (kind === 'style') {
    const problem = styleSlotsProblem(draft.style)
    return problem ? { problem } : { body: { slots: cleanStyleSlots(draft.style) } }
  }
  if (kind === 'person') {
    const problem = personSlotsProblem(draft.person)
    return problem ? { problem } : { body: { slots: cleanPersonSlots(draft.person) } }
  }
  const problem = memoryTextProblem(draft.text, category)
  return problem ? { problem } : { body: { text: draft.text.trim() } }
}

// ─── refusals ─────────────────────────────────────────────────────────────────

const ACCOUNT_GONE = 'Аккаунт недоступен. Войди заново'
const UNAVAILABLE = 'Память сейчас недоступна. Попробуй чуть позже'

export const MEMORY_SETTINGS_ERRORS: Record<UpdateMemorySettingsApiErrorCode, string> = {
  [UpdateMemorySettingsApiErrorCode.USER_NOT_FOUND]: ACCOUNT_GONE,
  [UpdateMemorySettingsApiErrorCode.CONSENT_REQUIRED]: 'Чтобы включить память, нужно твоё согласие',
  [UpdateMemorySettingsApiErrorCode.MEMORY_UNAVAILABLE]: UNAVAILABLE,
  [UpdateMemorySettingsApiErrorCode.MEMORY_NOT_ALLOWED]:
    'Память пока открыта не всем. Скоро она появится и у тебя',
}

/**
 * `FACT_REJECTED` is said neutrally, whatever the server's reason was: the person is not told what
 * class of words tripped the rule.
 */
export const MEMORY_FACT_ERRORS: Record<UpdateMemoryFactApiErrorCode | CreateMemoryFactApiErrorCode, string> =
  {
    [UpdateMemoryFactApiErrorCode.USER_NOT_FOUND]: ACCOUNT_GONE,
    [UpdateMemoryFactApiErrorCode.MEMORY_DISABLED]: 'Сначала включи память',
    [UpdateMemoryFactApiErrorCode.FACT_NOT_FOUND]: 'Этого я уже не помню',
    [UpdateMemoryFactApiErrorCode.FACT_REJECTED]: 'Это я не могу запомнить',
    [UpdateMemoryFactApiErrorCode.MEMORY_UNAVAILABLE]: UNAVAILABLE,
    [CreateMemoryFactApiErrorCode.MEMORY_FULL]: 'Память заполнена. Забудь что-нибудь, чтобы запомнить новое',
  }

export const MEMORY_FORGET_ERRORS: Record<ForgetMemoryApiErrorCode, string> = {
  [ForgetMemoryApiErrorCode.USER_NOT_FOUND]: ACCOUNT_GONE,
  [ForgetMemoryApiErrorCode.MEMORY_UNAVAILABLE]: 'Сейчас не получается забыть. Попробуй чуть позже',
  [ForgetMemoryApiErrorCode.FACT_UNSUPPORTED]:
    'Отдельный факт пока забыть нельзя. Можно забыть всё сразу в разделе «Память»',
}

// ─── the card "Я запомнил" ────────────────────────────────────────────────────

/** The card shows this many points at most; the rest are on the screen "Память". */
export const MEMORY_CARD_MAX_ITEMS = 4

export interface MemoryCardItem {
  fact: MemoryFactApiResponse
  /** Waits for "Запомнить": until then it is not used. */
  proposed: boolean
}

export interface MemoryCardContent {
  items: MemoryCardItem[]
  /** How many more there are beyond the card. */
  more: number
}

const CARD_OPS = new Set<string>([MemoryChangeOp.Add, MemoryChangeOp.Update, MemoryChangeOp.Supersede])
const CARD_STATUSES = new Set<string>([
  MemoryFactStatus.Active,
  MemoryFactStatus.Pinned,
  MemoryFactStatus.Proposed,
])

/**
 * What the card lists after a conversation: what is new or changed (a fact merely confirmed again is
 * not news), each fact once, the ones waiting for an answer first. Guesses stay off the card: they are
 * not used yet, and the screen "Память" shows them apart. Anything but `ready` lists nothing.
 */
export function memoryCardContent(changes: MemoryChangesApiResponse | null): MemoryCardContent {
  if (!changes || changes.status !== MemoryChangesStatus.Ready) return { items: [], more: 0 }
  const seen = new Set<string>()
  const items: MemoryCardItem[] = []
  for (const { op, fact } of changes.items) {
    if (!CARD_OPS.has(op) || !CARD_STATUSES.has(fact.status) || seen.has(fact.id)) continue
    seen.add(fact.id)
    items.push({ fact, proposed: fact.status === MemoryFactStatus.Proposed })
  }
  items.sort((a, b) => Number(b.proposed) - Number(a.proposed))
  return {
    items: items.slice(0, MEMORY_CARD_MAX_ITEMS),
    more: Math.max(0, items.length - MEMORY_CARD_MAX_ITEMS),
  }
}

/** The card appears only when there is something to list: `skipped`, `pending` and empty show nothing. */
export function shouldShowMemoryCard(changes: MemoryChangesApiResponse | null): boolean {
  return memoryCardContent(changes).items.length > 0
}

/**
 * Whether to look for the card at all once a conversation ends: not after one "without memory", and
 * not for a person whose memory is known to be off. Unknown (an older gateway) costs one request.
 */
export function shouldWatchMemoryChanges(dialog: {
  memoryMode?: string | null
  memoryEnabled?: boolean
}): boolean {
  return dialog.memoryMode !== 'off' && dialog.memoryEnabled !== false
}

export const MEMORY_POLL_INTERVAL_MS = 3_000
export const MEMORY_POLL_TIMEOUT_MS = 30_000

export interface MemoryPollOptions {
  intervalMs?: number
  timeoutMs?: number
  signal?: AbortSignal
  /** For tests: the clock and the pause between requests. */
  now?: () => number
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>
}

function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * Asks what a finished conversation added to memory, every 3 seconds for up to 30, until the answer is
 * `ready`. Resolves with that answer, or null when there is nothing to show: `skipped`, still `pending`
 * at the end, a refusal (an unknown dialog), or `signal` aborted. A failed request is asked again: the
 * card is a courtesy, and its absence is never reported to the person as an error.
 */
export async function pollMemoryChanges(
  load: () => Promise<ApiOutcome<MemoryChangesApiResponse, string>>,
  options: MemoryPollOptions = {},
): Promise<MemoryChangesApiResponse | null> {
  const interval = options.intervalMs ?? MEMORY_POLL_INTERVAL_MS
  const now = options.now ?? Date.now
  const wait = options.wait ?? waitFor
  const deadline = now() + (options.timeoutMs ?? MEMORY_POLL_TIMEOUT_MS)
  const { signal } = options

  for (;;) {
    if (signal?.aborted) return null
    const result = await load().catch(() => null)
    if (signal?.aborted) return null
    if (result && !result.ok) return null
    if (result?.ok) {
      if (result.data.status === MemoryChangesStatus.Ready) return result.data
      if (result.data.status === MemoryChangesStatus.Skipped) return null
    }
    if (now() + interval > deadline) return null
    await wait(interval, signal)
  }
}

/** What the card shows, and whose it is: a different signed-in account never sees it. */
export interface MemoryCardState extends MemoryCardContent {
  dialogId: string
  owner: string
}

/**
 * The card "Я запомнил" as module state: the conversation ends on its own screen, and the card shows
 * up on home a few seconds later, whatever screen is mounted in between. Framework-free; each app
 * wraps it in `useSyncExternalStore`.
 */
export function createMemoryCard(poll: Omit<MemoryPollOptions, 'signal'> = {}) {
  let state: MemoryCardState | null = null
  let watching: AbortController | null = null
  const listeners = new Set<() => void>()

  function set(next: MemoryCardState | null): void {
    state = next
    for (const listener of listeners) listener()
  }

  function stop(): void {
    watching?.abort()
    watching = null
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    getSnapshot(): MemoryCardState | null {
      return state
    },

    /**
     * Starts looking for the card of a conversation that has just ended; `load` asks the server once
     * (`client.getMemoryChanges`). A newer conversation replaces the older one's card, shown or still awaited.
     */
    watch(
      dialogId: string,
      owner: string,
      load: (dialogId: string) => Promise<ApiOutcome<MemoryChangesApiResponse, string>>,
    ): Promise<void> {
      stop()
      if (state) set(null)
      const controller = new AbortController()
      watching = controller
      return pollMemoryChanges(() => load(dialogId), { ...poll, signal: controller.signal }).then(
        (changes) => {
          if (controller.signal.aborted) return
          watching = null
          const content = memoryCardContent(changes)
          if (content.items.length > 0) set({ ...content, dialogId, owner })
        },
      )
    },

    /** A point taken off the card ("убрать", or forgotten elsewhere); the card goes when it is empty. */
    remove(factId: string): void {
      if (!state) return
      const items = state.items.filter((item) => item.fact.id !== factId)
      set(items.length === 0 && state.more === 0 ? null : { ...state, items })
    },

    /** A point the server answered for ("Запомнить"): it stays, no longer waiting. */
    update(fact: MemoryFactApiResponse): void {
      if (!state) return
      set({
        ...state,
        items: state.items.map((item) =>
          item.fact.id === fact.id ? { fact, proposed: fact.status === MemoryFactStatus.Proposed } : item,
        ),
      })
    },

    /** The person closed the card. */
    close(): void {
      if (state) set(null)
    },

    /** Sign-out, sign-in and "Забыть всё": nothing awaited or shown survives it. */
    reset(): void {
      stop()
      if (state) set(null)
    },
  }
}

export type MemoryCardStore = ReturnType<typeof createMemoryCard>

// ─── "Забыть" with five seconds to take it back ──────────────────────────────

export const FORGET_UNDO_MS = 5_000

/**
 * The forgetting the person can still take back: "Забыть" hides the fact at once and shows "Вернуть",
 * and the request goes only when the time is up. Module state rather than a screen's, so leaving the
 * screen within those seconds does not cancel what the person asked for. Framework-free.
 */
export function createPendingForgets(delayMs: number = FORGET_UNDO_MS) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let snapshot: ReadonlySet<string> = new Set()
  const listeners = new Set<() => void>()

  function emit(): void {
    snapshot = new Set(timers.keys())
    for (const listener of listeners) listener()
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    /** The ids still within their seconds: the screens hide those facts and show "Вернуть". */
    getSnapshot(): ReadonlySet<string> {
      return snapshot
    },

    /** `run` sends the request and handles its own outcome; it is not called if `undo` comes first. */
    schedule(factId: string, run: () => Promise<void> | void): void {
      clearTimeout(timers.get(factId))
      timers.set(
        factId,
        setTimeout(() => {
          timers.delete(factId)
          emit()
          void Promise.resolve()
            .then(run)
            .catch(() => undefined)
        }, delayMs),
      )
      emit()
    },

    /** "Вернуть": true when it was still in time. */
    undo(factId: string): boolean {
      const timer = timers.get(factId)
      if (timer === undefined) return false
      clearTimeout(timer)
      timers.delete(factId)
      emit()
      return true
    },

    has(factId: string): boolean {
      return timers.has(factId)
    },

    /** Sign-out: nothing of the previous account is sent after it. */
    cancelAll(): void {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      emit()
    },
  }
}

export type PendingForgets = ReturnType<typeof createPendingForgets>

// ─── this device ──────────────────────────────────────────────────────────────

/**
 * "Скрывать тексты на этом устройстве": on a computer others use too, the screen opens with the texts
 * of the facts hidden behind "Показать". It belongs to the device, like hands-free; the default is the
 * app's (`fallback`), and storage that refuses means the default.
 */
export function readHideMemoryTexts(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key)
    return value === null ? fallback : value === 'on'
  } catch {
    return fallback
  }
}

export function writeHideMemoryTexts(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? 'on' : 'off')
  } catch {
    // Not remembered: the next visit starts with the default.
  }
}

// ─── "Скачать мою память" ─────────────────────────────────────────────────────

/** `ryadom-memory-2026-10-12.json`, by the local day of the download. */
export function memoryExportFileName(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `ryadom-memory-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`
}

/** The file as the person gets it: the server's answer, readable. */
export function memoryExportText(data: MemoryExportApiResponse): string {
  return `${JSON.stringify(data, null, 2)}\n`
}
