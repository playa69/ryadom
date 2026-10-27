import {
  ForgetMemoryApiErrorCode,
  MEMORY_CONSENT_VERSION,
  MemoryChangeOp,
  MemoryChangesStatus,
  MemoryFactCategory,
  MemoryFactOrigin,
  MemoryFactStatus,
  MemoryInstructionApiErrorCode,
  MemoryNoteKind,
  UpdateMemoryFactApiErrorCode,
  UpdateMemorySettingsApiErrorCode,
  type MemoryApiResponse,
  type MemoryChangesApiResponse,
  type MemoryExportApiResponse,
  type MemoryFactApiResponse,
  type MemoryInstructionApiResponse,
  type MemoryNoteApiResponse,
} from '@ryadom/contracts/api/memory'
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
    'Всё, что я запомнил, ты видишь в «Профиль → Память»: каждую заметку можно исправить или удалить. Любой разговор можно не сохранять. Поставить память на паузу или удалить всё можно в любой момент.',
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
  'Заметки появляются по ходу разговора, обычно в течение минуты. Заметки хранятся, пока ты их не удалишь. Удаляя разговор, ты не удаляешь заметки из него.',
  'Самочувствие, веру и взгляды я запоминаю, только если ты включил «Запоминать чувствительное». Диагнозы, лекарства, документы и контакты не запоминаются никогда.',
  'Если выключить «Память», заметки останутся, но я не буду ими пользоваться. Разговор с галочкой «Не сохранять этот разговор» не попадает ни в журнал, ни в память.',
]

/**
 * Turning memory on shows the sheet first unless the person has accepted this very text before. A pause keeps the consent (the
 * agent answers with it while memory is off), so resuming does not ask again; a person who accepted an older text is asked again.
 */
export function needsMemoryConsent(memory: Pick<MemoryApiResponse, 'consentVersion'> | null): boolean {
  return memory?.consentVersion !== MEMORY_CONSENT_VERSION
}

// ─── whether memory is at work ────────────────────────────────────────────────

/**
 * Whether memory is at work for the person right now: their switch is on and the server can use it.
 * Home offers "Без памяти" only then; with the switch off or the service down there is nothing to hold back.
 */
export function memoryInUse(memory: Pick<MemoryApiResponse, 'enabled' | 'available'>): boolean {
  return memory.enabled && memory.available
}

/** The quiet word beside the section's row in the profile. */
export function memorySectionStatus(memory: Pick<MemoryApiResponse, 'enabled' | 'available'>): string {
  if (!memory.available) return 'недоступна'
  return memory.enabled ? 'включена' : 'на паузе'
}

/**
 * The mark of a conversation held "without memory" in the journal; null for any other. A conversation held unsaved is `off` too, but
 * it has a mark of its own ("Разговор не сохранён"), so it gets none here.
 */
export function dialogMemoryMark(dialog: {
  memoryMode?: string | null
  saved?: boolean | null
}): { label: string; hint: string } | null {
  return dialog.memoryMode === 'off' && dialog.saved !== false
    ? { label: 'Без памяти', hint: 'Рядом ничего не запомнит из этого разговора' }
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
    case MemoryFactStatus.Proposed:
      return 'Ждёт ответа'
    case MemoryFactStatus.Candidate:
      return 'Предположение'
    default:
      return null
  }
}

/**
 * What can be done with a fact. `delete` is "Забыть" (and "Не запоминать" is `decline`): both forget the fact for good.
 */
export type MemoryFactAction = 'edit' | 'delete' | 'decline'

export function memoryFactActions(fact: Pick<MemoryFactApiResponse, 'status'>): MemoryFactAction[] {
  switch (fact.status) {
    case MemoryFactStatus.Proposed:
      return ['decline']
    case MemoryFactStatus.Candidate:
    case MemoryFactStatus.Active:
      return ['edit', 'delete']
    default:
      return []
  }
}

/** The words on the buttons. */
export const MEMORY_ACTION_LABEL: Record<MemoryFactAction, string> = {
  edit: 'Исправить',
  delete: 'Забыть',
  decline: 'Не запоминать',
}

/** Puts a fact the server returned in place of the old one, keeping the order of the screen. */
export function replaceMemoryFact(
  facts: readonly MemoryFactApiResponse[],
  fact: MemoryFactApiResponse,
): MemoryFactApiResponse[] {
  return facts.map((item) => (item.id === fact.id ? fact : item))
}

// ─── refusals ─────────────────────────────────────────────────────────────────

const ACCOUNT_GONE = 'Аккаунт недоступен. Войди заново'
const UNAVAILABLE = 'Память сейчас недоступна. Попробуй чуть позже'

export const MEMORY_SETTINGS_ERRORS: Record<UpdateMemorySettingsApiErrorCode, string> = {
  [UpdateMemorySettingsApiErrorCode.USER_NOT_FOUND]: ACCOUNT_GONE,
  [UpdateMemorySettingsApiErrorCode.CONSENT_REQUIRED]: 'Чтобы включить память, нужно твоё согласие',
  [UpdateMemorySettingsApiErrorCode.MEMORY_UNAVAILABLE]: UNAVAILABLE,
}

/**
 * `FACT_REJECTED` is said neutrally, whatever the server's reason was: the person is not told what
 * class of words tripped the rule.
 */
export const MEMORY_FACT_ERRORS: Record<UpdateMemoryFactApiErrorCode, string> = {
  [UpdateMemoryFactApiErrorCode.USER_NOT_FOUND]: ACCOUNT_GONE,
  [UpdateMemoryFactApiErrorCode.FACT_NOT_FOUND]: 'Этого я уже не помню',
  [UpdateMemoryFactApiErrorCode.FACT_REJECTED]: 'Это я не могу запомнить',
  [UpdateMemoryFactApiErrorCode.MEMORY_UNAVAILABLE]: UNAVAILABLE,
}

export const MEMORY_FORGET_ERRORS: Record<ForgetMemoryApiErrorCode, string> = {
  [ForgetMemoryApiErrorCode.USER_NOT_FOUND]: ACCOUNT_GONE,
  [ForgetMemoryApiErrorCode.MEMORY_UNAVAILABLE]: 'Сейчас не получается забыть. Попробуй чуть позже',
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
const CARD_STATUSES = new Set<string>([MemoryFactStatus.Active, MemoryFactStatus.Proposed])

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

    /** A point the server answered for: it stays, no longer waiting. */
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


// ─── notes: the sheet "Что помнит Рядом" (PROTEUS-242) ────────────────────────

/** The groups of the sheet, in screen order (`design.md` D3): the kinds of notes each takes. */
export interface MemoryNoteGroup {
  id: string
  title: string
  notes: MemoryNoteApiResponse[]
}

const NOTE_GROUPS: ReadonlyArray<{ id: string; title: string; kinds: readonly string[] }> = [
  { id: 'about', title: 'Обо мне и как со мной говорить', kinds: [MemoryNoteKind.Name, MemoryNoteKind.Style] },
  { id: 'people', title: 'Близкие', kinds: [MemoryNoteKind.Person] },
  { id: 'work', title: 'Работа и дела', kinds: [MemoryNoteKind.Situation] },
  { id: 'events', title: 'События и планы', kinds: [MemoryNoteKind.Event] },
  { id: 'agreements', title: 'Договорённости', kinds: [MemoryNoteKind.Agreement] },
  { id: 'helps', title: 'Что помогает и радует', kinds: [MemoryNoteKind.Interest] },
  { id: 'boundaries', title: 'О чём не говорить', kinds: [MemoryNoteKind.Boundary] },
  { id: 'wellbeing', title: 'Самочувствие', kinds: [MemoryNoteKind.Wellbeing] },
  { id: 'beliefs', title: 'Взгляды', kinds: [MemoryNoteKind.Beliefs] },
]

/**
 * The notes grouped for the sheet: non-empty groups in screen order, newest first inside a group (the
 * server's order is kept). A kind this client does not know yet (a newer server) still shows, under
 * "Другое": a person must be able to see and delete everything that is remembered.
 */
export function groupNotes(notes: readonly MemoryNoteApiResponse[]): { groups: MemoryNoteGroup[]; count: number } {
  const known = new Set<string>(NOTE_GROUPS.flatMap((group) => group.kinds))
  const groups: MemoryNoteGroup[] = NOTE_GROUPS.map(({ id, title, kinds }) => ({
    id,
    title,
    notes: notes.filter((note) => kinds.includes(note.kind)),
  }))
  groups.push({ id: 'other', title: 'Другое', notes: notes.filter((note) => !known.has(note.kind)) })
  return { groups: groups.filter((group) => group.notes.length > 0), count: notes.length }
}

/** "12 окт." from a note's ISO time, in the person's calendar. */
export function memoryNoteDay(note: Pick<MemoryNoteApiResponse, 'createdAt'>, now: Date = new Date()): string {
  return memoryDay(note.createdAt.slice(0, 10), now)
}

/** A note with its date: "Работает в продажах · 12 окт." for the line of the sheet. */
export function noteDateLabel(note: Pick<MemoryNoteApiResponse, 'createdAt' | 'eventDate'>, now: Date = new Date()): string {
  const created = memoryNoteDay(note, now)
  return note.eventDate ? `${created} · событие ${memoryDay(note.eventDate, now)}` : created
}

export const MEMORY_SWITCHES = {
  memory: {
    title: 'Память',
    hint: 'Рядом запоминает важное о тебе по ходу разговоров',
  },
  sensitive: {
    title: 'Запоминать чувствительное',
    hint: 'Самочувствие, вера и взгляды, интимное. По умолчанию не запоминается',
  },
  chatSearch: {
    title: 'Опираться на прошлые разговоры',
    hint: 'Рядом может вспомнить, что ты говорил раньше, дословно',
  },
} as const

export const MEMORY_SHEET = {
  title: 'Что помнит Рядом',
  open: 'Посмотреть, что помнит Рядом',
  empty: 'Пока пусто — заметки появятся по мере разговоров',
  paused: 'Память на паузе — Рядом не использует эти заметки',
  instructionLabel: 'Скажи, что поправить или убрать',
  instructionPlaceholder: 'Например: «у меня не кот, а кошка»',
  instructionSend: 'Отправить',
  undo: 'Вернуть',
  forgetAll: 'Удалить всю память',
  forgetAllConfirm:
    'Удалить всю память? Рядом забудет всё, что успел узнать о тебе. Разговоры в журнале останутся',
  download: 'Скачать мою память',
  howItWorks: 'Как это работает',
  deleteHint: 'Если хочешь, чтобы Рядом совсем забыл, удали и разговор в журнале',
} as const

/** How the answer to "Скажи, что поправить" reads on the sheet. */
export function instructionResultText(changes: MemoryInstructionApiResponse): string {
  const parts: string[] = []
  if (changes.updated.length > 0) parts.push(`изменено: ${changes.updated.length}`)
  if (changes.deleted.length > 0) parts.push(`удалено: ${changes.deleted.length}`)
  if (changes.added.length > 0) parts.push(`запомнено: ${changes.added.length}`)
  if (parts.length > 0) {
    const text = parts.join(', ')
    return text.charAt(0).toUpperCase() + text.slice(1)
  }
  // A refusal of a rule is told neutrally: the person is not told which class of words tripped it.
  return changes.blocked.length > 0 ? 'Так запомнить не получится' : 'Ничего не нашлось'
}

export const MEMORY_INSTRUCTION_ERRORS: Record<MemoryInstructionApiErrorCode, string> = {
  [MemoryInstructionApiErrorCode.USER_NOT_FOUND]: ACCOUNT_GONE,
  [MemoryInstructionApiErrorCode.MEMORY_DISABLED]: 'Сначала включи память',
  [MemoryInstructionApiErrorCode.MEMORY_UNAVAILABLE]: UNAVAILABLE,
}

/** The three switches of the section as the screen shows them. */
export function memorySwitches(
  memory: Pick<MemoryApiResponse, 'enabled' | 'sensitiveEnabled' | 'chatSearchEnabled' | 'available'>,
): { memory: boolean; sensitive: boolean; chatSearch: boolean; sensitiveDisabled: boolean; chatSearchDisabled: boolean } {
  // The two lower switches work only while memory is on: on pause they stay as they were, but are not changed.
  return {
    memory: memory.enabled,
    sensitive: memory.sensitiveEnabled,
    chatSearch: memory.chatSearchEnabled,
    sensitiveDisabled: !memory.enabled || !memory.available,
    chatSearchDisabled: !memory.enabled || !memory.available,
  }
}

/** Replaces or removes a note in the list the screen holds, after a correction or "×" (the old fact helper `replaceMemoryFact` does the same for facts). */
export function replaceNote(
  notes: readonly MemoryNoteApiResponse[],
  id: string,
  next: MemoryNoteApiResponse | null,
): MemoryNoteApiResponse[] {
  return next === null ? notes.filter((note) => note.id !== id) : notes.map((note) => (note.id === id ? next : note))
}

// ─── "Запомнил: … · Убрать": the notice about a sensitive note (6.4) ──────────

/**
 * While "Запоминать чувствительное" is on, the conversation shows a line for every new sensitive note, like Claude's notice:
 * "Запомнил: <text> · Убрать". The notes are asked for every `MEMORY_NOTICE_POLL_MS` during a conversation; "Убрать" deletes the note
 * at once (the same call as "×", without the seconds for "Вернуть").
 */
export const MEMORY_NOTICE = { prefix: 'Запомнил: ', undo: 'Убрать' } as const
export const MEMORY_NOTICE_POLL_MS = 10_000

/** The sensitive notes the conversation has not told about yet: `known` holds the ids already seen (including those present at the start). */
export function newSensitiveNotes(known: ReadonlySet<string>, notes: readonly MemoryNoteApiResponse[]): MemoryNoteApiResponse[] {
  return notes.filter((note) => note.sensitive && !known.has(note.id))
}

/** The ids to remember as seen at the start of a conversation, so that old notes do not show up as new. */
export function noteIds(notes: readonly MemoryNoteApiResponse[]): Set<string> {
  return new Set(notes.map((note) => note.id))
}

// ─── the sheet "Рядом теперь запоминает важное" (6.7) ─────────────────────────

/** Shown once to a person who has never decided about memory; nothing is on by default, the person chooses. */
export const MEMORY_INVITE = {
  title: 'Рядом теперь запоминает важное',
  paragraphs: [
    'Рядом может запоминать важное о тебе по ходу разговоров, чтобы не начинать каждый раз с нуля.',
    'Всё, что запомнено, ты видишь в «Профиль → Память»: каждую заметку можно исправить или удалить. Включить или выключить память можно в любой момент.',
  ],
  accept: 'Включить',
  decline: 'Не сейчас',
} as const

/**
 * Whether to show the sheet: the feature works, the person has never accepted a memory consent and has not said "Не сейчас"
 * already. A pause keeps the consent, so someone who turned memory off never gets the invitation back; whether memory is on
 * right now does not matter, only whether the person has ever decided.
 */
export function shouldInviteToMemory(
  memory: Pick<MemoryApiResponse, 'available' | 'consentVersion'> | null,
  dismissed: boolean,
): boolean {
  return memory !== null && memory.available && memory.consentVersion === null && !dismissed
}
