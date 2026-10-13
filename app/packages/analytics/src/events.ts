/**
 * The product analytics event catalog: the one list of what «Рядом» reports to PostHog and with what.
 *
 * Rules for everything in here (they are what keeps this file safe to extend):
 *
 * - **No content.** Never a message, a transcript, a takeaway, a name, an email, a phone number or a
 *   token. A property is a boolean, a number, or a short value from a fixed set. `sanitize.ts` drops
 *   what looks like free text anyway, but the catalog is the first line of defence.
 * - **Pseudonymous people.** A person is their account id (a random UUID), never the email. Events
 *   about a crisis signal are reported without any person at all (`SafetySignal`).
 * - **`object_verb`, snake_case, past tense** for facts that already happened (`dialog_ended`), so the
 *   names read the same in funnels and in SQL.
 * - Server events are the source of truth for anything that changes state (an account, a session, a
 *   dialog): they cannot be lost to an ad blocker or a closed tab. Client events describe what only
 *   the screen knows (a tap, a toggle, a prompt shown).
 *
 * To add an event: add the member here, its properties to `AnalyticsEventProperties`, and use it.
 * The TypeScript compiler then rejects a call that passes anything else.
 */
export enum AnalyticsEvent {
  // ── Server: accounts and sessions (services/api) ────────────────────────────────────────────
  /** A new account exists. An email account is created unconfirmed; an anonymous one on first launch. */
  AccountCreated = 'account_created',
  /** The six-digit code from the email was accepted. */
  EmailConfirmed = 'email_confirmed',
  LoggedIn = 'user_logged_in',
  LoggedOut = 'user_logged_out',
  /** One session ended by the person from the list of sessions. */
  SessionRevoked = 'session_revoked',
  PasswordChanged = 'password_changed',
  PasswordResetRequested = 'password_reset_requested',
  PasswordResetCompleted = 'password_reset_completed',
  /** An anonymous account got an email and became a regular one. */
  EmailLinked = 'email_linked',
  /** The first screen: age, "this is not therapy", terms and personal data. */
  ConsentsAccepted = 'consents_accepted',
  /** Which fields of the profile changed, never their values. */
  ProfileUpdated = 'profile_updated',
  AccountDeleted = 'account_deleted',

  // ── Server: dialogs (services/api) ──────────────────────────────────────────────────────────
  DialogStarted = 'dialog_started',
  /**
   * One reply of the person was accepted by the server (typed, or a spoken turn the agent heard and wrote
   * down). The first one in a dialog is THE target action of the product: the person said something and
   * the conversation began. `dialog_started` is not that (the screen can open and stay silent), and
   * `dialog_ended` is not either (most people just close the app). The server reports it, so an ad blocker
   * or a closed tab cannot lose it.
   */
  DialogTurn = 'dialog_turn',
  /** The conversation finished properly: the agent confirmed the end. */
  DialogEnded = 'dialog_ended',
  /** The connection went away before the dialog ended (a dropped network, an idle timeout, a deploy). */
  DialogInterrupted = 'dialog_interrupted',
  /**
   * The agent called one of its components for a dialog (speech recognition, the safety check, the model,
   * speech synthesis, memory). It is the log behind the "calls to the solution per DAU" figure: one event
   * per real call, with no prompt, no text and no vendor error attached.
   */
  ComponentCalled = 'component_called',
  /**
   * The agent raised the safety frame. Reported with NO person attached: it counts how often the
   * hotlines were shown, and must not become a record of who was in crisis.
   */
  SafetySignal = 'safety_signal',

  // ── Client: the whole app ───────────────────────────────────────────────────────────────────
  /** A launch of the app or a new page load, once per start. */
  AppOpened = 'app_opened',
  CtaClicked = 'cta_clicked',
  AuthFormSubmitted = 'auth_form_submitted',
  EmailCodeResent = 'email_code_resent',

  // ── Client: the dialog screen ───────────────────────────────────────────────────────────────
  DialogScreenOpened = 'dialog_screen_opened',
  /** Pressing "start" found an unfinished dialog and asked what to do with it: the answer. */
  DialogResumeChoice = 'dialog_resume_choice',
  /** The text of the message is never sent: only its size class and how it was entered. */
  DialogMessageSent = 'dialog_message_sent',
  DialogVoiceToggled = 'dialog_voice_toggled',
  HandsFreeToggled = 'hands_free_toggled',
  DialogEndSheetOpened = 'dialog_end_sheet_opened',
  DialogEndSubmitted = 'dialog_end_submitted',
  SosOpened = 'sos_opened',
  HotlineCalled = 'hotline_called',
  BreathingStarted = 'breathing_started',
  /** Something about voice did not work: it tells the product where speech breaks for people. */
  VoiceProblem = 'voice_problem',

  // ── Client: other screens ───────────────────────────────────────────────────────────────────
  JournalEntryOpened = 'journal_entry_opened',
  DeleteAccountStep = 'delete_account_step',
  /** The "add to home screen" banner and the install prompt. */
  InstallPrompt = 'install_prompt',
  /** A new web build, an OTA bundle or a store release was offered, accepted or dismissed. */
  AppUpdate = 'app_update',
  OfflineShown = 'offline_shown',

  // ── Client: memory ──────────────────────────────────────────────────────────────────────────
  // What the person does with memory, never what is remembered: no text, category or count of facts.
  /** The screen "Профиль → Память" was opened. */
  MemoryScreenOpened = 'memory_screen_opened',
  /** The switch "Запоминать" took effect (on after the consent sheet, or off). */
  MemoryEnabled = 'memory_enabled',
  /** One action on one fact on the screen "Память"; `delete` is counted when the request goes, after "Вернуть" had its chance. */
  MemoryFactAction = 'memory_fact_action',
  /** "Забыть всё" was confirmed and done. */
  MemoryForgetAll = 'memory_forget_all',
  /** "Скачать мою память": the file was handed to the person. */
  MemoryExport = 'memory_export',
  /** The switch "Без памяти" on home, before a conversation. */
  MemoryIncognitoToggled = 'memory_incognito_toggled',
  /** A point of the card "Я запомнил" after a conversation was taken off or accepted. */
  MemoryCardAction = 'memory_card_action',

  // ── Client: the landing ─────────────────────────────────────────────────────────────────────
  FaqOpened = 'faq_opened',
  StoreLinkClicked = 'store_link_clicked',
}

/** Where the code runs. `pwa` is the web build installed to the home screen or opened from it. */
export type AnalyticsPlatform = 'web' | 'pwa' | 'android' | 'ios' | 'landing'

/** How an account signs in or was made. */
export type AccountKind = 'email' | 'anonymous'

/** A coarse classification of a number of characters, so that no exact length of a message leaves the device. */
export type SizeClass = 'short' | 'medium' | 'long'

export type AuthForm =
  | 'login'
  | 'register'
  | 'confirm_email'
  | 'forgot_password'
  | 'reset_password'
  | 'link_email'
  | 'change_password'
  | 'device_start'

/** What happened to a form: `invalid` is a validation message the person saw, `rejected` is the server saying no. */
export type FormOutcome = 'success' | 'invalid' | 'rejected' | 'rate_limited' | 'error'

/** The calls to action that can be told apart on the landing and on the first screens. */
export type CtaId =
  | 'open_web_app'
  | 'start_anonymous'
  | 'register'
  | 'login'
  | 'install_pwa'
  | 'download_android'
  | 'download_page'
  | 'see_how_it_works'
  | 'contact_support'
  | 'hotline'

export type StoreLink = 'google_play' | 'rustore' | 'app_store' | 'apk' | 'pwa' | 'web_app'

export type VoiceProblemReason =
  | 'permission_denied'
  | 'no_microphone'
  | 'unsupported'
  | 'asr_unavailable'
  | 'tts_unavailable'
  | 'playback_failed'

/**
 * Why a dialog's connection went away before the dialog ended. A rollout (`1012`) and a second
 * connection of the same person (`4009`) are planned closes after which the client comes back to the
 * same dialog; they are not interruptions of the person's conversation and are not reported.
 */
export type DialogInterruptReason =
  | 'client_closed'
  | 'idle'
  | 'max_duration'
  | 'agent_unavailable'
  | 'unauthorized'
  | 'rate_limited'
  | 'other'

/**
 * Whose traffic an account is: `real` people, or `test` (load tests, scripted checks) and `internal` (the team).
 * It is stored on the account and attached to every event of the person, so a figure can be taken without
 * the traffic that is not people, and the organiser can see in the raw log which accounts are not counted.
 */
export type TrafficType = 'real' | 'test' | 'internal'

/** The parts of the agent that answer a person. `memory` is the look-up of the person's long-term memory for a reply (only when memory is on). */
export const COMPONENT_NAMES = ['stt', 'safety', 'llm', 'live', 'tts', 'memory'] as const
export type ComponentName = (typeof COMPONENT_NAMES)[number]

/** `ok` is an answer, `error` is a call that failed. A repeat served from the cache is `ok` with `cached: true`. */
export type ComponentOutcome = 'ok' | 'error'

export type AppUpdateKind = 'service_worker' | 'ota' | 'store'
export type AppUpdateAction = 'available' | 'applied' | 'dismissed' | 'forced'
export type InstallPromptAction = 'shown' | 'accepted' | 'dismissed' | 'ios_instructions'

export type SafetyLevelName = 'concern' | 'crisis'

export type DeleteAccountStepName = 'opened' | 'confirmed' | 'cancelled'

/** The person's answer to the unfinished dialog: go on with it, end it and begin a new one, or close the question. */
export type ResumeChoice = 'continue' | 'new' | 'dismissed'

/**
 * What became of the recap the closing sheet put into "what you take with you": none was offered,
 * sent as it was, edited, or erased. Never the text.
 */
export type RecapOutcome = 'none' | 'kept' | 'edited' | 'cleared'

export type ProfileField = 'name' | 'voice'

/** What was done with a fact of memory: the names are those of the buttons' meaning, never of the fact. */
export type MemoryFactActionName = 'edit' | 'pin' | 'unpin' | 'delete' | 'confirm' | 'accept' | 'decline'

/** A point of the card "Я запомнил": taken off ("убрать") or accepted ("Запомнить"). */
export type MemoryCardActionName = 'dismiss_item' | 'accept_item'

export type PasswordChangeKind = 'change' | 'reset'

/** Properties that every event of a platform carries are added by the SDK wrapper, not here. */
export type NoProperties = Record<never, never>

export interface AnalyticsEventProperties {
  [AnalyticsEvent.AccountCreated]: { kind: AccountKind }
  [AnalyticsEvent.EmailConfirmed]: NoProperties
  [AnalyticsEvent.LoggedIn]: { method: 'password' | 'device' | 'email_code' }
  [AnalyticsEvent.LoggedOut]: { all_devices: boolean }
  [AnalyticsEvent.SessionRevoked]: NoProperties
  [AnalyticsEvent.PasswordChanged]: NoProperties
  [AnalyticsEvent.PasswordResetRequested]: NoProperties
  [AnalyticsEvent.PasswordResetCompleted]: NoProperties
  [AnalyticsEvent.EmailLinked]: NoProperties
  [AnalyticsEvent.ConsentsAccepted]: { policy_version: string }
  [AnalyticsEvent.ProfileUpdated]: { fields: ProfileField[] }
  [AnalyticsEvent.AccountDeleted]: NoProperties

  /**
   * `dialog_id` is the dialog's own random id (the one in the agent's database and the journal). It is on
   * every event of a dialog, so a start, its replies and its end can be put together; without it a figure
   * can only be matched per person.
   */
  [AnalyticsEvent.DialogStarted]: { dialog_id?: string; resumed: boolean; hours_since_last: number | null }
  [AnalyticsEvent.DialogTurn]: { dialog_id?: string; input: 'text' | 'voice' }
  [AnalyticsEvent.DialogEnded]: {
    dialog_id?: string
    via: 'socket' | 'rest'
    /**
     * `dialog`: `user_messages` and `assistant_messages` count the whole dialog, over every connection and a
     * rollout in between (the agent counts them). `connection`: only the connection that ended it, which is
     * all the server knows when the agent did not say (an agent older than this field).
     */
    counts?: 'dialog' | 'connection'
    /** Of the connection that ended the dialog; absent when the end came over REST. */
    duration_s?: number
    user_messages?: number
    assistant_messages?: number
    has_takeaway: boolean
    /** after minus before, -9..9; absent unless both were given. Negative means the tension went down. */
    tension_delta?: number
    tension_improved?: boolean
  }
  [AnalyticsEvent.DialogInterrupted]: {
    dialog_id?: string
    reason: DialogInterruptReason
    /** Of this connection, not of the whole dialog: a dialog can have several. */
    duration_s: number
    user_messages: number
  }
  [AnalyticsEvent.ComponentCalled]: {
    dialog_id?: string
    component: ComponentName
    outcome: ComponentOutcome
    cached: boolean
  }
  [AnalyticsEvent.SafetySignal]: { level: SafetyLevelName }

  [AnalyticsEvent.AppOpened]: { standalone: boolean; first_launch?: boolean }
  [AnalyticsEvent.CtaClicked]: { cta: CtaId; placement: string }
  [AnalyticsEvent.AuthFormSubmitted]: { form: AuthForm; outcome: FormOutcome }
  [AnalyticsEvent.EmailCodeResent]: { form: 'confirm_email' | 'reset_password' }

  [AnalyticsEvent.DialogScreenOpened]: { resumed: boolean }
  [AnalyticsEvent.DialogResumeChoice]: { choice: ResumeChoice }
  [AnalyticsEvent.DialogMessageSent]: { input: 'text' | 'voice'; size: SizeClass }
  [AnalyticsEvent.DialogVoiceToggled]: { enabled: boolean }
  [AnalyticsEvent.HandsFreeToggled]: { enabled: boolean }
  [AnalyticsEvent.DialogEndSheetOpened]: NoProperties
  /**
   * The tension itself is never sent: the server reports how it changed, in `DialogEnded`.
   * `skipped` is true when the sheet was closed with nothing filled in (no takeaway and no tension).
   * `recap` is what became of the recap the sheet offered as the takeaway.
   */
  [AnalyticsEvent.DialogEndSubmitted]: {
    has_takeaway: boolean
    gave_tension: boolean
    skipped: boolean
    recap: RecapOutcome
  }
  /** Send with `trackAnonymous`: how often SOS is opened, not who opened it. */
  [AnalyticsEvent.SosOpened]: { source: 'header' | 'dialog' | 'safety_frame' | 'home' | 'menu' }
  /** Send with `trackAnonymous`: a tap on a hotline's number, not whose. */
  [AnalyticsEvent.HotlineCalled]: { hotline: string }
  [AnalyticsEvent.BreathingStarted]: { source: 'home' | 'dialog' | 'sos' }
  [AnalyticsEvent.VoiceProblem]: { reason: VoiceProblemReason }

  [AnalyticsEvent.JournalEntryOpened]: NoProperties
  [AnalyticsEvent.DeleteAccountStep]: { step: DeleteAccountStepName }
  [AnalyticsEvent.MemoryScreenOpened]: NoProperties
  [AnalyticsEvent.MemoryEnabled]: { enabled: boolean }
  [AnalyticsEvent.MemoryFactAction]: { action: MemoryFactActionName }
  [AnalyticsEvent.MemoryForgetAll]: NoProperties
  [AnalyticsEvent.MemoryExport]: NoProperties
  [AnalyticsEvent.MemoryIncognitoToggled]: { on: boolean }
  [AnalyticsEvent.MemoryCardAction]: { action: MemoryCardActionName }
  [AnalyticsEvent.InstallPrompt]: { action: InstallPromptAction }
  [AnalyticsEvent.AppUpdate]: { kind: AppUpdateKind; action: AppUpdateAction }
  [AnalyticsEvent.OfflineShown]: NoProperties

  [AnalyticsEvent.FaqOpened]: { question: string }
  [AnalyticsEvent.StoreLinkClicked]: { store: StoreLink }
}

/**
 * The arguments of `track(event, ...args)`: the properties are required when the event has any
 * and omitted when it has none.
 */
export type AnalyticsEventArgs<E extends AnalyticsEvent> = NoProperties extends AnalyticsEventProperties[E]
  ? [properties?: AnalyticsEventProperties[E]]
  : [properties: AnalyticsEventProperties[E]]

/** What is known about a person, set once on sign-in. Never an email or a name. */
export interface AnalyticsTraits {
  account_kind: AccountKind
  /** Absent means `real`; set by the server only, from the account. */
  traffic_type?: TrafficType
}

/** Properties are a closed set of shapes, which is what `sanitizeProperties` enforces at run time. */
export type PropertyValue = string | number | boolean | null | undefined | readonly (string | number | boolean)[]

/** An anonymous account has no address; the address itself is never reported. */
export function accountKindOf(user: { email: string | null }): AccountKind {
  return user.email === null ? 'anonymous' : 'email'
}

/**
 * How a form ended, from the HTTP status of the failed request. One mapping for every client, so the
 * same answer of the server lands in the same bucket on every platform:
 *
 * - `rate_limited`: 429;
 * - `invalid`: 422, the server's own input rule, a message the person can act on;
 * - `rejected`: the other 4xx, the server saying no (a wrong password, a taken address);
 * - `error`: no answer at all, a 5xx, and 400, which means our client sent something the server did
 *   not understand: a bug of ours, never a mistake of the person.
 */
export function formOutcomeFromStatus(status: number): FormOutcome {
  if (status === 429) return 'rate_limited'
  if (status === 422) return 'invalid'
  if (status === 400) return 'error'
  if (status >= 400 && status < 500) return 'rejected'
  return 'error'
}

/**
 * How a form ended when the server answered 200 with a named rule (`{ status: false, errorCode }`):
 * a refusal, except "too many attempts", which is a limit. Every contract enum spells it the same.
 */
export function formOutcomeFromCode(code: string): FormOutcome {
  return code === 'TOO_MANY_ATTEMPTS' ? 'rate_limited' : 'rejected'
}

/** A size class for a number of characters: 0-80 short, 81-400 medium, more long. */
export function sizeClass(chars: number): SizeClass {
  if (chars <= 80) return 'short'
  if (chars <= 400) return 'medium'
  return 'long'
}
