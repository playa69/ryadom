import type { HotlineApiResponse, SafetyLevel, SafetyStage } from '@ryadom/contracts/api/dialogs'
import { HOTLINES } from './hotlines'

/**
 * What the screen shows during the crisis branch (openspec/changes/extend-crisis-branch, «Скрипт красного
 * уровня»). The agent leads with `safety` frames that carry a `stage`; this module turns each frame into the
 * state of the screen and a decision about the help sheet, so the web and the mobile client behave the same.
 * A frame without a stage (an agent from before the script) only opens the default sheet, as it always did.
 */

export interface CrisisUi {
  /** A crisis session is on: the sphere is calm, and `help_returned` may be sent. */
  active: boolean
  /** Show «Да» · «Нет» · «Не знаю». */
  askSafe: boolean
  /** Pin the «Позвонить сейчас» button above the conversation until the session ends. */
  pinCall: boolean
  /** Show the «Нужна помощь?» banner at the top. */
  banner: boolean
}

export const CRISIS_IDLE: CrisisUi = { active: false, askSafe: false, pinCall: false, banner: false }

/** Which sheet a frame asks for; `null` leaves the sheet as it is. */
export type SheetRequest = 'default' | 'help' | 'call112' | 'close' | null

export interface SafetyInput {
  level: SafetyLevel
  stage?: SafetyStage
  showCall?: boolean
}

export function reduceSafety(prev: CrisisUi, input: SafetyInput): { ui: CrisisUi; sheet: SheetRequest } {
  const { stage } = input
  switch (stage) {
    case 'help':
      return { ui: { ...prev, active: true, askSafe: false }, sheet: 'help' }
    case 'ask_safe':
      return { ui: { ...prev, active: true, askSafe: true }, sheet: null }
    case 'call112':
      return { ui: { ...prev, active: true, askSafe: false }, sheet: 'call112' }
    case 'stay':
      return { ui: { ...prev, active: true, askSafe: false, pinCall: input.showCall ?? true }, sheet: 'close' }
    case 'check':
      // The agent speaks; the screen stays as it is.
      return { ui: { ...prev, active: true, askSafe: false }, sheet: null }
    case 'ask_hopeless':
      return { ui: prev, sheet: null }
    case 'calm':
      return { ui: { ...prev, active: true, askSafe: false, banner: true }, sheet: null }
    default:
      // An agent from before the script: the sheet opens as it always did and nothing else on screen changes.
      return { ui: prev, sheet: 'default' }
  }
}

export const CRISIS_TEXT = {
  helpTitle: 'Сейчас важно поговорить с живым человеком',
  callNow: 'Позвонить сейчас',
  call112: '112 — если есть опасность для жизни',
  safeLink: 'Я в безопасности, давай продолжим',
  safeAnswer: 'Да, я в безопасности',
  banner: 'Нужна помощь?',
  askSafe: ['Да', 'Нет', 'Не знаю'],
} as const

/** The line behind «Позвонить сейчас». */
export const CALL_NOW_HOTLINE: HotlineApiResponse = HOTLINES.find((line) => line.name === 'Психологическая помощь МЧС России') ?? {
  name: 'Психологическая помощь МЧС России',
  phone: '8 (495) 989-50-50',
}
/** The lines shown under the main buttons: everything but 112, which has its own button. */
export const OTHER_HOTLINES = HOTLINES.filter((line) => line.phone !== '112')

type Listener = () => void

export interface CrisisSnapshot {
  ui: CrisisUi
  sheetOpen: boolean
}

/** Screen state shared between the dialog and the help sheet; read it with `useSyncExternalStore`. */
export function createCrisisStore() {
  let snapshot: CrisisSnapshot = { ui: CRISIS_IDLE, sheetOpen: false }
  let answerHandler: ((text: string) => void) | null = null
  const listeners = new Set<Listener>()
  const set = (next: Partial<CrisisSnapshot>) => {
    snapshot = { ...snapshot, ...next }
    listeners.forEach((listener) => listener())
  }
  return {
    subscribe(listener: Listener): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: (): CrisisSnapshot => snapshot,
    /** Applies a `safety` frame and says what to do with the sheet. */
    onSafety(input: SafetyInput): SheetRequest {
      const { ui, sheet } = reduceSafety(snapshot.ui, input)
      set({ ui })
      return sheet
    },
    setSheetOpen(sheetOpen: boolean): void {
      if (sheetOpen !== snapshot.sheetOpen) set({ sheetOpen })
    },
    /** The dialog registers how an answer is sent as an ordinary message. */
    setAnswerHandler(handler: ((text: string) => void) | null): void {
      answerHandler = handler
    },
    /** A tap on «Да» / «Нет» / «Не знаю» or the safe link: the words go to the agent as the person's message. */
    answer(text: string): void {
      answerHandler?.(text)
      if (snapshot.ui.askSafe) set({ ui: { ...snapshot.ui, askSafe: false } })
    },
    /** The session is over or the screen is left. */
    reset(): void {
      set({ ui: CRISIS_IDLE })
    },
  }
}

export type CrisisStore = ReturnType<typeof createCrisisStore>

/**
 * Calls `onReturn` once when the person comes back to the app after tapping a `tel:` link. The tap itself is
 * caught at the document, so every hotline row and button counts without wiring each one. Away means the
 * page is hidden or loses focus (a phone dialler covers the app); back means visible and focused again.
 */
export function watchHelpReturn(onReturn: () => void, doc: Document = document, win: Window = window): () => void {
  let called = false
  let away = false
  const onClick = (event: Event) => {
    const link = (event.target as Element | null)?.closest?.('a[href^="tel:"]')
    if (link) {
      called = true
      away = false
    }
  }
  const leave = () => {
    if (called) away = true
  }
  const back = () => {
    if (called && away && doc.visibilityState !== 'hidden') {
      called = false
      away = false
      onReturn()
    }
  }
  const onVisibility = () => (doc.visibilityState === 'hidden' ? leave() : back())
  doc.addEventListener('click', onClick, true)
  doc.addEventListener('visibilitychange', onVisibility)
  win.addEventListener('blur', leave)
  win.addEventListener('focus', back)
  return () => {
    doc.removeEventListener('click', onClick, true)
    doc.removeEventListener('visibilitychange', onVisibility)
    win.removeEventListener('blur', leave)
    win.removeEventListener('focus', back)
  }
}

/** One per app: the dialog screen and the help sheet are far apart in the tree. */
export const crisisStore = createCrisisStore()
