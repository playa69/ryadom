'use client'

import { Brain, EyeOff } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useId, useRef, useState } from 'react'
import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import {
  DialogMode,
  StartDialogApiErrorCode,
  type StartDialogApiResponse,
} from '@ryadom/contracts/api/dialogs'
import { chosenStart, nextStartStep } from '@ryadom/client-core/dialog-start'
import { rememberUnsaved, UNSAVED_HINT, UNSAVED_LABEL } from '@ryadom/client-core/unsaved'
import { DialogMemoryMode, type MemoryApiResponse } from '@ryadom/contracts/api/memory'
import { MEMORY_SETTINGS_ERRORS, memoryInUse, needsMemoryConsent } from '@ryadom/client-core/memory'
import { apiErrorText, codeText } from '@ryadom/client-core/errors'
import { Button } from '@ryadom/ui/components/button'
import { Checkbox } from '@ryadom/ui/components/checkbox'
import { cn } from '@ryadom/ui/lib/utils'
import { ConsentNotice } from '@/app/(auth)/_components/consent-group'
import { DIALOG_KEEP_NOTE, GUEST_LIFE_CLAUSE } from '@ryadom/client-core/retention'
import { formOutcome, trackForm } from '@/lib/analytics'
import { useAuth, useClient } from '@/lib/auth'
import { AppHeader } from './AppHeader'
import { useSiteUrl } from './AppShell'
import Breathing from './Breathing'
import ChatComposer from './ChatComposer'
import { BUTTON, FOCUS_RING } from './controls'
import { rememberDialogStart } from './dialog-start'
import MemoryConsent from './MemoryConsent'
import ResumeDialogSheet from './ResumeDialogSheet'
import { unlockSpeech } from '@ryadom/client-core/voice/speech'

/**
 * Home as the empty state of a chat app: the breathing sphere, a greeting, and the
 * input box in the middle of the page. Sending starts a conversation and carries the typed text
 * over as its first message; with nothing typed, "Поговорить" and the microphone both start one
 * that opens on the voice and begins listening. If the person left a conversation unfinished (with
 * something said in it), the start waits for their answer: continue it, end it and begin a new one,
 * or close the question and stay here with the draft untouched.
 *
 * Someone new sees the same home, as a guest: the first message (or the microphone) is the agreement
 * the line at the foot of the page speaks of, and it makes the account for this device before the
 * conversation starts.
 *
 * Memory is a choice made here, not a sheet that interrupts: with memory off, "Запоминать важное" turns it
 * on (with the consent sheet the profile uses; for a guest, once the account exists); with memory on, a
 * switch "Без памяти" holds the next conversation without it, and after a conversation the card
 * "Я запомнил" shows up here. A tick "Не сохранять этот разговор" is a choice of its own, always there:
 * that conversation leaves nothing behind, memory or no memory. None of them is needed to start.
 *
 * There are no modes to pick: one conversation, which starts as `vent` (the server ignores the mode).
 */
const mode = DialogMode.Vent

const START_ERRORS: Record<StartDialogApiErrorCode, string> = {
  [StartDialogApiErrorCode.USER_NOT_FOUND]: 'Аккаунт недоступен. Войди заново',
  [StartDialogApiErrorCode.USER_INACTIVE]: 'Аккаунт заблокирован. Напиши нам, разберёмся',
  [StartDialogApiErrorCode.CONSENT_REQUIRED]: 'Сначала нужно подтвердить согласие',
}

function greeting(name: string | null): string {
  const hour = new Date().getHours()
  const part =
    hour < 5 ? 'Поздний вечер' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер'
  return name ? `${part}, ${name}` : part
}

export default function HomeScreen() {
  const { status, user, updateUser, startAnonymously } = useAuth()
  const siteUrl = useSiteUrl()
  /** Nobody signed in yet: the first message makes the account. */
  const guest = status !== 'authenticated'
  // Computed in the browser only: the server's clock and time zone are not the person's.
  const [hello, setHello] = useState('')
  useEffect(() => setHello(greeting(user?.name ?? null)), [user?.name])
  const client = useClient()
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  /** A ref beside the state: two presses in one tick would both see `loading` as still false. */
  const starting = useRef(false)
  /** Not mounted any more (the person went elsewhere while the request was out): nothing is handed over. */
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  /** The unfinished conversation a start found and the press that found it: the question is open over them. */
  const [pending, setPending] = useState<{
    data: StartDialogApiResponse
    draft: string
    listen: boolean
  } | null>(null)
  /** "End it and begin a new one" is in flight. */
  const [renewing, setRenewing] = useState(false)
  const [pendingError, setPendingError] = useState('')

  const userId = user?.id ?? null
  const memoryEnabled = user?.memoryEnabled
  /** "Без памяти" for the next conversation; home starts without it every time. */
  const [withoutMemory, setWithoutMemory] = useState(false)
  /** "Не сохранять этот разговор" for the next conversation; like "Без памяти", it is off at every visit and fixed once the conversation starts. */
  const [unsaved, setUnsaved] = useState(false)
  const unsavedId = useId()
  /** What the server said about memory; null until it arrives. */
  const [memoryState, setMemoryState] = useState<MemoryApiResponse | null>(null)
  /** A guest asked for memory: it is turned on once the account exists, before the conversation starts. */
  const [rememberOnStart, setRememberOnStart] = useState(false)
  const [memoryConsentOpen, setMemoryConsentOpen] = useState(false)
  const [memoryBusy, setMemoryBusy] = useState(false)
  const [memoryError, setMemoryError] = useState('')
  const choice = chosenStart(memoryEnabled, withoutMemory, unsaved)
  const wanted = choice.memory

  // Whether to offer "Без памяти" is asked each time home opens: the person's switch and whether the
  // server uses memory at all can both change elsewhere. A failed request leaves what was known.
  useEffect(() => {
    if (!userId) return
    let cancelled = false
    client
      .getMemory()
      .then((memory) => {
        if (cancelled) return
        setMemoryState(memory)
        updateUser({ memoryEnabled: memoryInUse(memory) })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client, userId, updateUser])

  /** A start that says memory is off for the person is believed at once; "on" is left to the request above. */
  function learnMemory(data: StartDialogApiResponse) {
    if (data.memoryEnabled === false && memoryEnabled !== false) updateUser({ memoryEnabled: false })
  }

  /** Hands a started dialog to the dialog screen, with what the person typed or asked for on home. */
  function openDialog(data: StartDialogApiResponse, draft: string, listen: boolean) {
    // Only the answer decides: a gateway that did not hold the dialog unsaved has promised nothing.
    if (data.saved === false) rememberUnsaved(data.dialogId)
    rememberDialogStart(
      data.dialogId,
      {
        greeting: data.greeting,
        resumed: data.resumed,
        sinceLastDialogHours: data.sinceLastDialogHours,
        memoryMode: data.memoryMode,
        saved: data.saved,
        memoryEnabled: data.memoryEnabled,
      },
      { draft, listen },
    )
    router.push(`/dialog/${encodeURIComponent(data.dialogId)}`)
  }

  /** Turns memory on for the account and records the consent (the same call the profile makes). */
  async function enableMemory(): Promise<boolean> {
    const result = await client.setMemoryEnabled(true)
    if (!result.ok) {
      setMemoryError(codeText(MEMORY_SETTINGS_ERRORS, result.code, 'Не получилось включить память'))
      return false
    }
    const next = memoryState ? { ...memoryState, ...result.data, paused: !result.data.enabled } : null
    if (next) setMemoryState(next)
    updateUser({ memoryEnabled: next ? memoryInUse(next) : result.data.enabled })
    track(AnalyticsEvent.MemoryEnabled, { enabled: result.data.enabled })
    track(AnalyticsEvent.MemorySettingChanged, { setting: 'memory', enabled: result.data.enabled })
    return result.data.enabled
  }

  /** "Запоминать важное": the consent sheet when it was never given for this text, otherwise straight on. */
  async function turnMemoryOn() {
    if (memoryBusy) return
    if (guest) {
      if (rememberOnStart) setRememberOnStart(false)
      else setMemoryConsentOpen(true)
      return
    }
    if (needsMemoryConsent(memoryState)) {
      setMemoryConsentOpen(true)
      return
    }
    setMemoryBusy(true)
    setMemoryError('')
    try {
      await enableMemory()
    } catch (err) {
      setMemoryError(apiErrorText(err, {}, 'Не получилось включить память'))
    } finally {
      setMemoryBusy(false)
    }
  }

  async function acceptMemoryConsent() {
    if (guest) {
      // Nothing to record yet: the account is made by the first message, and memory is turned on then.
      setRememberOnStart(true)
      setMemoryConsentOpen(false)
      return
    }
    setMemoryBusy(true)
    setMemoryError('')
    try {
      if (await enableMemory()) setMemoryConsentOpen(false)
    } catch (err) {
      setMemoryError(apiErrorText(err, {}, 'Не получилось включить память'))
    } finally {
      setMemoryBusy(false)
    }
  }

  async function start(draft: string, listen: boolean) {
    if (starting.current) return
    // A conversation that opens on the voice has the sphere speak first: this press lets speech through.
    unlockSpeech()
    starting.current = true
    setError('')
    setLoading(true)
    let leaving = false
    // What this start asks for; a guest's choices are settled once the account exists.
    let { memory: wanted, saved } = choice
    try {
      if (guest) {
        // The press is the agreement the line at the foot of the page speaks of: the account for this device,
        // with the consents recorded, then memory if the person asked for it.
        track(AnalyticsEvent.CtaClicked, { cta: 'start_anonymous', placement: 'welcome' })
        try {
          await startAnonymously({ consent: true })
          trackForm('device_start', 'success')
        } catch (err) {
          trackForm('device_start', formOutcome(err))
          throw err
        }
        const remembered = rememberOnStart && (await enableMemory().catch(() => false))
        ;({ memory: wanted, saved } = chosenStart(remembered, false, unsaved))
      }
      let result = await client.startDialog(mode, { memory: wanted, saved })
      // The handoff is armed only for a screen that is still here to push to the dialog: one armed for a
      // person who has left would wait for the next visit to that dialog and send the draft then.
      if (!alive.current) return
      if (!result.ok) {
        // The server has no agreement on record for this account: forget what was cached, and the
        // app's gate takes the person through the first screen.
        if (result.code === StartDialogApiErrorCode.CONSENT_REQUIRED) updateUser({ consentVersion: null })
        setError(codeText(START_ERRORS, result.code, 'Не получилось начать разговор'))
        return
      }
      learnMemory(result.data)
      const step = nextStartStep(result.data, wanted, saved)
      if (step === 'ask') {
        // Something was said in the conversation left open. Nothing changes until the person answers, and the
        // text they typed stays in the box; the press is released below so that the sheet's buttons can work.
        setPendingError('')
        setPending({ data: result.data, draft, listen })
        return
      }
      if (step === 'restart') {
        // An empty open conversation chosen otherwise (memory, saving): nothing in it to lose, a new one as chosen.
        result = await client.startDialog(mode, { startNew: true, memory: wanted, saved })
        if (!alive.current) return
        if (!result.ok) {
          setError(codeText(START_ERRORS, result.code, 'Не получилось начать разговор'))
          return
        }
      }
      openDialog(result.data, draft, listen)
      leaving = true
    } catch (err) {
      if (alive.current) setError(apiErrorText(err, {}, 'Не получилось начать разговор'))
    } finally {
      // After a successful start the box stays busy until this screen unmounts: the navigation takes a
      // moment, and a press in that gap would start a second request and arm the same draft twice.
      if (!leaving) {
        starting.current = false
        setLoading(false)
      }
    }
  }

  /** "Продолжить": the same dialog, as a start without a question used to open it. */
  function continueDialog() {
    if (!pending || starting.current) return
    unlockSpeech()
    starting.current = true
    setLoading(true)
    track(AnalyticsEvent.DialogResumeChoice, { choice: 'continue' })
    openDialog(pending.data, pending.draft, pending.listen)
    setPending(null)
  }

  /** "Завершить и начать новый": the second start, the one that ends the open dialog. */
  async function startNew() {
    if (!pending || starting.current) return
    unlockSpeech()
    starting.current = true
    setPendingError('')
    setRenewing(true)
    let leaving = false
    try {
      const result = await client.startDialog(mode, { startNew: true, memory: wanted, saved: choice.saved })
      if (!alive.current) return
      if (!result.ok) {
        if (result.code === StartDialogApiErrorCode.CONSENT_REQUIRED) updateUser({ consentVersion: null })
        setPendingError(codeText(START_ERRORS, result.code, 'Не получилось начать новый разговор'))
        return
      }
      track(AnalyticsEvent.DialogResumeChoice, { choice: 'new' })
      openDialog(result.data, pending.draft, pending.listen)
      setPending(null)
      setLoading(true)
      leaving = true
    } catch (err) {
      if (alive.current) setPendingError(apiErrorText(err, {}, 'Не получилось начать новый разговор'))
    } finally {
      if (!leaving) starting.current = false
      if (alive.current) setRenewing(false)
    }
  }

  /** Backdrop, Esc, "Закрыть": nothing is started or ended, the person stays here with the draft. */
  function dismissQuestion() {
    if (starting.current) return
    track(AnalyticsEvent.DialogResumeChoice, { choice: 'dismissed' })
    setPending(null)
  }

  return (
    <>
      <AppHeader title="Новый разговор" titleIsHeading={false} />
      {/*
        Two parts split 4:6 at one fixed line: the sphere and the greeting sit above it, the box and
        what follows below. The box's top edge therefore stays put while a long draft grows it
        downward, instead of the whole stack drifting up around a middle.
      */}
      <div className="flex flex-1 flex-col px-4 tab:px-6">
        <div className="flex flex-[4] flex-col items-center justify-end gap-4 pt-6 pb-6 short:gap-2 short:pt-3 short:pb-3">
          <div data-testid="home-orb">
            <Breathing className="w-24 tab:w-28 short:w-16" />
          </div>

          <div className="flex max-w-xl flex-col items-center gap-2 text-center">
            <h1
              className="text-2xl leading-tight font-bold tracking-display-tight text-balance text-foreground wrap-anywhere tab:text-3xl"
              data-testid="home-greeting"
            >
              {hello}
            </h1>
            <p className="text-base leading-[1.55] text-dim text-balance tab:text-lg">
              Я здесь и никуда не спешу. О чём хочется сказать?
            </p>
          </div>
        </div>

        <div className="flex flex-[6] flex-col items-center gap-4 pb-[calc(2rem+env(safe-area-inset-bottom,0px))] short:gap-3 short:pb-6">
          <div className="w-full max-w-3xl">
            <ChatComposer
              variant="hero"
              testIdPrefix="home"
              placeholder="Напиши или скажи, что на душе…"
              busy={loading}
              emptyLabel="Поговорить"
              keepDraft
              autoFocus
              // Typed words open the text, with those words as the first message; "Поговорить" without any, like the
              // microphone, opens the voice and starts listening: the conversation is talked first.
              onSubmit={(text) => void start(text, text === '')}
              onMic={(text) => void start(text, true)}
            />
          </div>

          {/* A start that failed must be seen where the person is looking: right under the box. */}
          {error && (
            <p
              className="max-w-[40ch] text-center text-base leading-snug text-danger"
              role="alert"
              data-testid="form-error"
            >
              {error}
            </p>
          )}

          {/* Memory off (or someone new): the way to turn it on is here, not in a sheet that interrupts. */}
          {memoryEnabled !== true && (guest || memoryState?.available === true) && (
            <div
              className="flex max-w-md flex-col items-center gap-1.5 text-center"
              data-testid="memory-switch"
            >
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-pressed={guest && rememberOnStart}
                disabled={memoryBusy}
                onClick={() => void turnMemoryOn()}
                data-testid="memory-switch-toggle"
                className={cn(
                  BUTTON,
                  'outline-none',
                  'gap-1.5 border-input! px-3.5 text-sm text-dim enabled:hover:text-foreground',
                  'aria-pressed:border-brand-line! aria-pressed:bg-brand-soft aria-pressed:text-foreground',
                )}
              >
                <Brain
                  aria-hidden="true"
                  className={cn('size-4', guest && rememberOnStart && 'text-brand-400')}
                />
                Запоминать важное
              </Button>
              <p className="text-xs leading-normal text-faint" aria-live="polite">
                {guest && rememberOnStart
                  ? 'Включится с первым разговором; выключить можно в профиле'
                  : 'Чтобы не начинать каждый раз с нуля. По желанию'}
              </p>
              {memoryError && !memoryConsentOpen && (
                <p className="text-xs leading-normal text-danger" role="alert">
                  {memoryError}
                </p>
              )}
            </div>
          )}

          {/* Only while memory is on: without it every conversation is "without memory" anyway. */}
          {memoryEnabled === true && (
            <div className="flex max-w-md flex-col items-center gap-1.5 text-center" data-testid="incognito">
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-pressed={withoutMemory}
                onClick={() => {
                  const on = !withoutMemory
                  setWithoutMemory(on)
                  track(AnalyticsEvent.MemoryIncognitoToggled, { on })
                }}
                data-testid="incognito-toggle"
                className={cn(
                  BUTTON,
                  'outline-none',
                  'gap-1.5 border-input! px-3.5 text-sm text-dim enabled:hover:text-foreground',
                  'aria-pressed:border-brand-line! aria-pressed:bg-brand-soft aria-pressed:text-foreground',
                )}
              >
                <EyeOff aria-hidden="true" className={cn('size-4', withoutMemory && 'text-brand-400')} />
                Без памяти
              </Button>
              <p className="text-xs leading-normal text-faint" aria-live="polite">
                {withoutMemory
                  ? 'Этот разговор я не запомню'
                  : 'Можно провести следующий разговор так, чтобы я его не запомнил'}
              </p>
            </div>
          )}

          {/* Always there, memory or no memory: this conversation is kept out of the journal, the recaps and the analytics. */}
          <div className="flex max-w-md flex-col items-center gap-1 text-center" data-testid="unsaved">
            <div className="flex items-center gap-2.5">
              <Checkbox
                id={unsavedId}
                checked={unsaved}
                onCheckedChange={(checked) => setUnsaved(checked === true)}
                data-testid="unsaved-toggle"
                className={cn(
                  FOCUS_RING,
                  'cursor-pointer rounded-[6px] border-2 bg-surface data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground [&_svg]:stroke-[3.75] forced-colors:data-[state=checked]:border-[Highlight] dark:forced-colors:data-[state=checked]:bg-[Highlight] forced-colors:data-[state=checked]:text-[HighlightText] forced-colors:data-[state=checked]:forced-color-adjust-none',
                )}
              />
              <label htmlFor={unsavedId} className="cursor-pointer text-sm text-dim">
                {UNSAVED_LABEL}
              </label>
            </div>
            <p className="text-xs leading-normal text-faint">{UNSAVED_HINT}</p>
          </div>
        </div>

        {/* The foot of the page, always in the same place: for someone new, what the first message agrees to. */}
        <div
          className="mx-auto flex max-w-2xl flex-col items-center gap-1 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] text-center"
          data-testid="home-foot"
        >
          {guest ? (
            <>
              <ConsentNotice
                termsUrl={`${siteUrl}/terms`}
                privacyUrl={`${siteUrl}/privacy`}
                className="text-xs"
              />
              <p className="text-xs leading-normal text-dim">В опасной ситуации звони&nbsp;112.</p>
              <p className="text-xs leading-normal text-faint text-balance">
                {DIALOG_KEEP_NOTE} Без почты аккаунт {GUEST_LIFE_CLAUSE}.
              </p>
            </>
          ) : (
            <p className="text-xs leading-normal text-faint">
              «Рядом»&nbsp;— самоподдержка, не психотерапия. В опасной ситуации звони&nbsp;112.
            </p>
          )}
          {/* A padded link: a line of text is 16px high, a finger needs 44. */}
          <Link
            href="/people"
            className={cn(
              FOCUS_RING,
              'inline-flex min-h-11 items-center rounded-sm px-3 text-sm text-dim underline underline-offset-4 outline-none hover:text-foreground',
            )}
          >
            Люди рядом&nbsp;— линии помощи
          </Link>
        </div>
      </div>

      <MemoryConsent
        open={memoryConsentOpen}
        kind="consent"
        busy={memoryBusy}
        error={memoryError}
        onAccept={() => void acceptMemoryConsent()}
        onClose={() => {
          if (!memoryBusy) setMemoryConsentOpen(false)
        }}
      />

      <ResumeDialogSheet
        open={pending !== null}
        onContinue={continueDialog}
        onStartNew={() => void startNew()}
        onClose={dismissQuestion}
        busy={renewing}
        error={pendingError}
        // A returned conversation keeps the choices it began with: "Без памяти" and "Не сохранять" apply only to a new one.
        note={
          unsaved && pending?.data.saved === false
            ? undefined
            : unsaved
              ? '«Не сохранять» будет только у нового разговора: этот продолжится как обычно.'
              : wanted === DialogMemoryMode.Off && pending?.data.memoryMode !== DialogMemoryMode.Off
                ? '«Без памяти» будет только у нового разговора: этот продолжится с памятью.'
                : undefined
        }
      />
    </>
  )
}
