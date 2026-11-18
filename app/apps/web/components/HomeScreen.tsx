'use client'

import { Keyboard, Mic } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import {
  DialogMode,
  StartDialogApiErrorCode,
  type StartDialogApiResponse,
} from '@ryadom/contracts/api/dialogs'
import { chosenStart, nextStartStep } from '@ryadom/client-core/dialog-start'
import { rememberUnsaved } from '@ryadom/client-core/unsaved'
import { DialogMemoryMode, type MemoryApiResponse } from '@ryadom/contracts/api/memory'
import { memoryInUse } from '@ryadom/client-core/memory'
import { DEVICE_LOGIN_REFUSED_TEXT, apiErrorText, codeText, isDeviceLoginRefused } from '@ryadom/client-core/errors'
import { Button } from '@ryadom/ui/components/button'
import { NativeCheckbox } from '@ryadom/ui/components/native-checkbox'
import { cn } from '@ryadom/ui/lib/utils'
import { ConsentNotice } from '@/app/(auth)/_components/consent-group'
import { PRIMARY_BUTTON } from '@/app/(auth)/_components/parts'
import { formOutcome, trackForm } from '@/lib/analytics'
import { useAuth, useClient } from '@/lib/auth'
import { AppHeader } from './AppHeader'
import { useSiteUrl } from './AppShell'
import Breathing from './Breathing'
import ConsentModal from './ConsentModal'
import FirstHello from './FirstHello'
import ThemeSwitch from './ThemeSwitch'
import { BUTTON, FOCUS_RING } from './controls'
import { rememberDialogStart } from './dialog-start'
import { rememberDialogView } from './dialog-view'
import ResumeDialogSheet from './ResumeDialogSheet'
import { unlockSpeech } from '@ryadom/client-core/voice/speech'

/**
 * Home, for someone signed in: the breathing sphere, a greeting, and one press to a new conversation.
 * "Начать разговор" opens it on the voice, which listens after the agent's greeting; the keyboard beside
 * it opens it on the text with an empty box. There is no box, no suggestions and no settings here: the
 * voice is the way in, and memory is turned on and off in the profile. With memory on, one tick holds
 * the next conversation without it. If the person left a conversation unfinished (with something said
 * in it), the start waits for their answer: continue it, end it and begin a new one, or close the
 * question and stay here.
 *
 * Someone new (no consent in this session) meets the first screen instead (FirstHello): the sphere asks
 * to talk, and the consent window opens only on a press, so nothing is sent before the tick. "Продолжить"
 * makes the account for this device, records the consents, turns memory on (the tick says so) and opens
 * the conversation the way the press asked for. The first screen stays up while that runs, so home never
 * flashes before the first conversation; a failed start shows there and retries without the window.
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
  /** Nobody signed in yet: the first start makes the account after an explicit consent. */
  const guest = status !== 'authenticated'
  /** The consent window's answer, kept for the session: a failed start retries without the window. */
  const [dataConsented, setDataConsented] = useState(false)
  /** The consent window over home: the press that opened it waits in `consentIntent`. */
  const [consentOpen, setConsentOpen] = useState(false)
  /** The waiting start: the voice/text intent survives the window's close (Esc, backdrop, cross). */
  const [consentIntent, setConsentIntent] = useState<{ listen: boolean } | null>(null)
  /** The first screen's start ran: that screen stays until the conversation opens, and shows a failed start. */
  const [startedFirst, setStartedFirst] = useState(false)
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
  const [pending, setPending] = useState<{ data: StartDialogApiResponse; listen: boolean } | null>(null)
  /** "End it and begin a new one" is in flight. */
  const [renewing, setRenewing] = useState(false)
  const [pendingError, setPendingError] = useState('')

  const userId = user?.id ?? null
  const memoryEnabled = user?.memoryEnabled
  /** "Не запоминать этот разговор" for the next conversation; home starts without it every time. */
  const [withoutMemory, setWithoutMemory] = useState(false)
  /** What the server said about memory; null until it arrives. */
  const [memoryState, setMemoryState] = useState<MemoryApiResponse | null>(null)
  const choice = chosenStart(memoryEnabled, withoutMemory, false)
  const wanted = choice.memory

  // Whether to offer the tick is asked each time home opens: the person's switch and whether the
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

  /** Hands a started dialog to the dialog screen, on the voice or on the text as the press asked. */
  function openDialog(data: StartDialogApiResponse, listen: boolean) {
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
      { draft: '', listen },
    )
    // The keyboard press: with nothing typed to hand over, the conversation would otherwise open on the voice.
    if (!listen) rememberDialogView(data.dialogId, 'text')
    router.push(`/dialog/${encodeURIComponent(data.dialogId)}`)
  }

  /**
   * Turns memory on for the new account: the consent tick covered it. The same call the profile makes,
   * with the memory consent's current version. A refusal is not an error here: the conversation starts
   * without memory, and the profile can turn it on later.
   */
  async function enableMemory(): Promise<boolean> {
    const result = await client.setMemoryEnabled(true)
    if (!result.ok) return false
    const next = memoryState ? { ...memoryState, ...result.data, paused: !result.data.enabled } : null
    if (next) setMemoryState(next)
    updateUser({ memoryEnabled: next ? memoryInUse(next) : result.data.enabled })
    track(AnalyticsEvent.MemoryEnabled, { enabled: result.data.enabled })
    track(AnalyticsEvent.MemorySettingChanged, { setting: 'memory', enabled: result.data.enabled })
    return result.data.enabled
  }

  /**
   * The first screen's presses. Without a consent given in the window this session they only open the
   * window: no account, no dialog, no request.
   */
  function requestStart(listen: boolean) {
    if (starting.current) return
    if (guest && !dataConsented) {
      setConsentIntent({ listen })
      setConsentOpen(true)
      return
    }
    void start(listen)
  }

  /** "Продолжить" in the consent window: the answer is recorded by the waiting start, which now runs. */
  function confirmConsent() {
    const intent = consentIntent
    if (!intent || starting.current) return
    // The first screen stays up while the start runs, so home does not flash before the conversation.
    setStartedFirst(true)
    setDataConsented(true)
    setConsentOpen(false)
    setConsentIntent(null)
    void start(intent.listen)
  }

  async function start(listen: boolean) {
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
        // The consent window has enabled this action: make the account and record its consents, then memory.
        track(AnalyticsEvent.CtaClicked, { cta: 'start_anonymous', placement: 'welcome' })
        try {
          await startAnonymously({ consent: true })
          trackForm('device_start', 'success')
        } catch (err) {
          trackForm('device_start', formOutcome(err))
          throw err
        }
        // Memory is on from the first conversation: the tick covered it, and the profile turns it off.
        const remembered = await enableMemory().catch(() => false)
        ;({ memory: wanted, saved } = chosenStart(remembered, false, false))
      }
      let result = await client.startDialog(mode, { memory: wanted, saved })
      // The handoff is armed only for a screen that is still here to push to the dialog: one armed for a
      // person who has left would wait for the next visit to that dialog and start listening then.
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
        // Something was said in the conversation left open. Nothing changes until the person answers; the
        // press is released below so that the sheet's buttons can work.
        setPendingError('')
        setPending({ data: result.data, listen })
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
      openDialog(result.data, listen)
      leaving = true
    } catch (err) {
      if (alive.current) {
        setError(
          guest && isDeviceLoginRefused(err)
            ? DEVICE_LOGIN_REFUSED_TEXT
            : apiErrorText(err, {}, 'Не получилось начать разговор'),
        )
      }
    } finally {
      // After a successful start the buttons stay busy until this screen unmounts: the navigation takes a
      // moment, and a press in that gap would start a second request.
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
    openDialog(pending.data, pending.listen)
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
      openDialog(result.data, pending.listen)
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

  /** Backdrop, Esc, "Закрыть": nothing is started or ended, the person stays here. */
  function dismissQuestion() {
    if (starting.current) return
    track(AnalyticsEvent.DialogResumeChoice, { choice: 'dismissed' })
    setPending(null)
  }

  // Someone new meets the first screen, and its consent window starts the conversation at once: the first
  // visit never shows home, which a returning person meets from the second conversation on.
  if (guest || startedFirst) {
    return (
      <>
        <AppHeader title="Новый разговор" titleIsHeading={false} actions={<ThemeSwitch />} />
        <FirstHello
          busy={loading}
          error={error}
          onVoice={() => requestStart(true)}
          onText={() => requestStart(false)}
        />
        <ConsentModal
          open={consentOpen}
          termsUrl={`${siteUrl}/terms`}
          consentUrl={`${siteUrl}/consent`}
          onContinue={confirmConsent}
          onClose={() => setConsentOpen(false)}
        />
      </>
    )
  }

  return (
    <>
      <AppHeader title="Новый разговор" titleIsHeading={false} actions={<ThemeSwitch />} />
      {/*
        Two parts split 4:6 at one fixed line: the sphere and the greeting sit above it, the start
        buttons and what follows below, so the buttons stay at the same height on every visit.
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
          {/*
            One press starts the conversation on the voice: no suggestions and no box. The keyboard beside it
            starts it on the text instead. A conversation left open is never ended behind the person's back:
            either press asks first, continue it or end it and begin a new one. The press is still needed: a
            browser lets the sphere speak only after a gesture, and a microphone that opens by itself on a
            visit would feel like being listened to.
          */}
          <div className="flex w-full max-w-md items-stretch gap-2">
            <Button
              type="button"
              className={cn(PRIMARY_BUTTON, 'min-w-0 flex-1')}
              aria-busy={loading || undefined}
              disabled={loading}
              onClick={() => void start(true)}
              data-testid="home-start-voice"
            >
              <Mic aria-hidden="true" className="size-5" />
              Начать разговор
            </Button>
            {/* Text is the other way in, quieter than the voice: an icon beside the button, named for screen readers. */}
            <Button
              type="button"
              variant="outline"
              aria-label="Начать текстом"
              title="Начать текстом"
              disabled={loading}
              onClick={() => void start(false)}
              data-testid="home-start-text"
              className={cn(BUTTON, 'h-auto min-h-13 w-13 shrink-0 border-input! p-0')}
            >
              <Keyboard aria-hidden="true" className="size-5" />
            </Button>
          </div>

          {/* A start that failed must be seen where the person is looking: right under the buttons. */}
          {error && (
            <p
              className="max-w-[40ch] text-center text-base leading-snug text-danger"
              role="alert"
              data-testid="form-error"
            >
              {error}
            </p>
          )}

          {/*
            Memory is on from the first conversation; turning it off for good is in the profile. What stays
            here is the one-off choice: this next conversation is not remembered.
          */}
          {memoryEnabled === true && (
            <label
              className="flex cursor-pointer items-center gap-2.5 text-sm text-dim"
              data-testid="incognito"
            >
              <NativeCheckbox
                checked={withoutMemory}
                onChange={(event) => {
                  setWithoutMemory(event.target.checked)
                  track(AnalyticsEvent.MemoryIncognitoToggled, { on: event.target.checked })
                }}
                data-testid="incognito-toggle"
                className="rounded-[6px]"
              />
              Не запоминать этот разговор
            </label>
          )}
        </div>

        {/* What the service is and its documents stay within reach after the consent was given. */}
        <div
          className="mx-auto flex max-w-2xl flex-col items-center gap-1 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] text-center"
          data-testid="home-foot"
        >
          <ConsentNotice
            termsUrl={`${siteUrl}/terms`}
            consentUrl={`${siteUrl}/consent`}
            className="text-xs"
          />
          <p className="text-xs leading-normal text-dim">В опасной ситуации звони&nbsp;112.</p>
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

      <ResumeDialogSheet
        open={pending !== null}
        onContinue={continueDialog}
        onStartNew={() => void startNew()}
        onClose={dismissQuestion}
        busy={renewing}
        error={pendingError}
        // A returned conversation keeps its memory mode: the tick applies only to a new one.
        note={
          wanted === DialogMemoryMode.Off && pending?.data.memoryMode !== DialogMemoryMode.Off
            ? '«Не запоминать» относится только к новому разговору: этот продолжится с памятью.'
            : undefined
        }
      />
    </>
  )
}
