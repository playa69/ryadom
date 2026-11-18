import { Button, Icon, Page } from 'framework7-react'
import type { Router } from 'framework7/types'
import { useCallback, useEffect, useRef, useState } from 'react'
import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { chosenStart, nextStartStep } from '@ryadom/client-core/dialog-start'
import { rememberUnsaved } from '@ryadom/client-core/unsaved'
import {
  DialogMode,
  StartDialogApiErrorCode,
  type StartDialogApiResponse,
} from '@ryadom/contracts/api/dialogs'
import { DialogMemoryMode } from '@ryadom/contracts/api/memory'
import { memoryInUse } from '@ryadom/client-core/memory'
import { outcomeFromCode, outcomeFromError, reportForm } from '../../../lib/analytics'
import {
  DEVICE_LOGIN_REFUSED_TEXT,
  apiErrorText,
  codeText,
  deviceLogin,
  getMemory,
  isDeviceLoginRefused,
  startDialog,
  telegramLogin,
} from '../../../lib/api'
import { needsFirstActionConsent } from '../../../lib/consent-gate'
import { enableMemory } from '../../../lib/memory'
import { requestTalkOnHome, START_TALK_EVENT, takeTalkRequest, type TalkRequest } from '../../../lib/nav'
import { isNative } from '../../../lib/platform'
import { isTelegramMiniApp, telegramInitData } from '../../../lib/telegram'
import { telegramLoginErrorText } from '../../../lib/telegram-account'
import { unlockSpeech } from '../../../lib/voice/speech'
import { useAuth } from '../../../lib/store'
import { useEnvSwitcherTaps } from '../../../lib/use-env-switcher'
import { SHORT_QUERY, useMediaQuery, WIDE_QUERY } from '../../../lib/viewport'
import { BrandMark } from '../../Brand'
import Breathing from '../../Breathing'
import ConsentNote from '../../ConsentNote'
import ConsentSheet from '../../ConsentSheet'
import FirstHello from '../../FirstHello'
import { SosButton, openSos } from '../../SosSheet'
import ThemeSwitch from '../../ThemeSwitch'
import ResumeDialogSheet from './ResumeDialogSheet'

/**
 * Home screen: the breathing circle and one large talk button. If the person left a
 * conversation unfinished (with something said in it), the talk button waits for their answer:
 * continue it, end it and begin a new one, or close the question and stay here.
 *
 * In the PWA and Telegram the screen also has the first-message field and the suggestions: with a
 * text the button becomes «Отправить» and the conversation opens in its text view, without one
 * «Поговорить» stays a voice start. The native shell keeps the voice-only start. A start intention
 * (text or voice) survives the question about the unfinished conversation, and a failed start keeps
 * the typed text.
 *
 * In the PWA and Telegram a new person lands here directly, with no consent gate before home: the
 * field, the suggestions and the theme switch work locally, and the first text or voice start with
 * no current consent on record opens the consent sheet over home instead of sending anything
 * («Согласие при первом действии»). Its «Продолжить» makes the account (by device or Telegram),
 * records the consents and then runs the original start; closing the sheet keeps the draft and the
 * intention, and a failed chain keeps both without reopening the sheet. The native shell keeps the
 * gate on the first screen and never shows the sheet. Nothing here calls a protected endpoint before
 * the session exists.
 *
 * With memory off, "Запоминать важное" turns it on here (with the consent sheet when the consent was never
 * given); with memory on, a switch "Без памяти" under the button holds the next conversation without it,
 * and after a conversation the card "Я запомнил" shows up here. None of them is needed to start. In the PWA
 * and Telegram the choice folds into the collapsed «Настроить разговор» under the start button, as on the
 * web, so it does not compete with the field and the button; the native shell keeps it in plain view.
 *
 * There are no modes to pick: one conversation, which starts as `vent` (the server ignores the mode).
 */

/** How a start opens the conversation: voice listens after the greeting, text hands a first message over. */
interface StartIntent {
  listen: boolean
  /** The keyboard: the conversation opens in its text view with an empty box; absent means voice. */
  text?: boolean
}

const VOICE_INTENT: StartIntent = { listen: true }
const TEXT_INTENT: StartIntent = { listen: false, text: true }

const mode = DialogMode.Vent

/**
 * How long a start stays locked after it navigated. The home page stays mounted under the dialog, so
 * the lock cannot wait for an unmount; the transition takes a few hundred milliseconds, and a second tap
 * inside it must not start (and so, now, end) a conversation again.
 */
const NAVIGATION_LOCK_MS = 1000

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

export default function HomePage({ f7router }: { f7router: Router.Router }) {
  const { auth, login, acceptConsents, updateUser } = useAuth()
  // Entry to the env picker (dev build): taps on the mark of the anonymous top bar.
  const onLogoTap = useEnvSwitcherTaps()
  const isWide = useMediaQuery(WIDE_QUERY)
  const isShort = useMediaQuery(SHORT_QUERY)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const telegram = isTelegramMiniApp()

  /** Set at once on a press, unlike `loading`: two taps in one tick would both see that as still false. */
  const starting = useRef(false)
  /** The unfinished conversation a start found: the question is open over it. */
  const [prompt, setPrompt] = useState<StartDialogApiResponse | null>(null)
  /** "End it and begin a new one" is in flight. */
  const [renewing, setRenewing] = useState(false)
  /** The question was answered (or its request is out): closing the sheet is then no "dismissed". */
  const answered = useRef(false)
  /** The intention of the start that found an unfinished conversation, kept until the question is answered. */
  const pendingIntent = useRef<StartIntent>(VOICE_INTENT)
  /** A new person of the PWA and Telegram: the first screen instead of home. */
  const firstScreen = !isNative() && !auth.isAuthenticated

  /** The consent sheet over home (PWA and Telegram): opened by a start with no current consent on record. */
  const [consentSheetOpen, setConsentSheetOpen] = useState(false)
  /** The sheet's tick, owned here so a close or a document link does not untick it. */
  const [sheetConsented, setSheetConsented] = useState(false)
  /** The intention of the start that opened the sheet: «Продолжить» goes on with it. */
  const consentIntent = useRef<StartIntent>(VOICE_INTENT)
  /** Consent confirmed in this session (or on the way over the sign-in): an error does not reopen the sheet. */
  const consentConfirmed = useRef(false)
  /** Resolves the wait for the sheet's full close: the sign-in swaps the screens, and an unmount of
      a half-open sheet leaves its backdrop behind, blocking the screen. */
  const consentSheetClosed = useRef<(() => void) | null>(null)

  /** Closes the consent sheet and waits until it is fully gone. */
  function closeConsentSheet(): Promise<void> {
    if (!consentSheetOpen) return Promise.resolve()
    return new Promise((resolve) => {
      consentSheetClosed.current = () => {
        consentSheetClosed.current = null
        resolve()
      }
      setConsentSheetOpen(false)
      // A missing closed event must not hang the start; the close transition is a few hundred ms.
      setTimeout(() => consentSheetClosed.current?.(), 500)
    })
  }

  const userId = auth.user?.id ?? null
  const signedIn = auth.isAuthenticated
  const memoryEnabled = auth.user?.memoryEnabled
  /** "Без памяти" for the next conversation; it goes back to off once a conversation starts. */
  const [withoutMemory, setWithoutMemory] = useState(false)
  const choice = chosenStart(memoryEnabled, withoutMemory, false)
  const wanted = choice.memory

  // Whether to offer "Без памяти" is asked whenever home comes into view: the person's switch and
  // whether the server uses memory at all can both change elsewhere. A failure leaves what was known.
  // «Поговорить» on the first screen, carried over the sign-in with its choices: taken once, when home first appears.
  const fromWelcome = useRef<TalkRequest | null | undefined>(undefined)
  if (fromWelcome.current === undefined) fromWelcome.current = takeTalkRequest()

  const loadMemory = useCallback(() => {
    if (!userId) return
    getMemory()
      .then((memory) => {
        updateUser({ memoryEnabled: memoryInUse(memory) })
      })
      .catch(() => {})
  }, [userId, updateUser])

  useEffect(() => {
    loadMemory()
  }, [loadMemory])

  function release(navigated: boolean) {
    if (navigated) setTimeout(() => (starting.current = false), NAVIGATION_LOCK_MS)
    else starting.current = false
  }

  /** A start that says memory is off for the person is believed at once; "on" is left to `loadMemory`. */
  function learnMemory(data: StartDialogApiResponse) {
    if (data.memoryEnabled === false && memoryEnabled !== false) updateUser({ memoryEnabled: false })
  }

  function openDialog(data: StartDialogApiResponse, intent: StartIntent) {
    // Only the answer decides: a gateway that did not hold the dialog unsaved has promised nothing.
    if (data.saved === false) rememberUnsaved(data.dialogId)
    f7router.navigate(`/dialog/${data.dialogId}/`, {
      props: {
        greeting: data.greeting,
        resumed: data.resumed,
        sinceLastDialogHours: data.sinceLastDialogHours,
        memoryMode: data.memoryMode ?? DialogMemoryMode.On,
        saved: data.saved,
        memoryEnabled: data.memoryEnabled,
        // A voice start opens on the sphere and listens. A text start opens the text view and hands
        // the typed message over once: the dialog queues it and sends it when the connection is ready.
        listen: intent.listen,
        ...(intent.text ? { initialMode: 'text' as const } : {}),
      },
    })
    setWithoutMemory(false)
  }

  async function handleTalk({
    chosen = choice,
    intent = VOICE_INTENT,
  }: { chosen?: ReturnType<typeof chosenStart>; intent?: StartIntent } = {}) {
    if (starting.current) return
    if (
      needsFirstActionConsent({
        native: isNative(),
        authenticated: auth.isAuthenticated,
        consentVersion: auth.user?.consentVersion,
        confirmedInSession: consentConfirmed.current,
      })
    ) {
      // No account, conversation or request before the agreements: the sheet over home asks first.
      consentIntent.current = intent
      setConsentSheetOpen(true)
      return
    }
    if (!auth.isAuthenticated) {
      // Reached only when the confirmation was already given this session (a retry after a failed
      // chain): the sheet is not reopened, the account chain runs directly.
      await beginWithoutAccount(intent)
      return
    }
    const { memory: wanted, saved } = chosen
    // A voice start opens on the sphere, which speaks first: speech is let through by this tap. A text
    // start needs neither the microphone nor the speaker.
    if (intent.listen) unlockSpeech()
    starting.current = true
    setError('')
    setLoading(true)
    let navigated = false
    try {
      let result = await startDialog(mode, { memory: wanted, saved })
      if (!result.ok) {
        // The server has no agreement on record for this account: forget what was cached, and the
        // next start asks again — the gate on the native shell, the consent sheet here.
        if (result.code === StartDialogApiErrorCode.CONSENT_REQUIRED) {
          consentConfirmed.current = false
          updateUser({ consentVersion: null })
        }
        setError(codeText(START_ERRORS, result.code, 'Не получилось начать разговор'))
        return
      }
      learnMemory(result.data)
      const step = nextStartStep(result.data, wanted, saved)
      if (step === 'ask') {
        // Something was said in the conversation left open. Nothing changes until the person answers,
        // and the text-or-voice intention of this start waits for the answer with the question.
        answered.current = false
        pendingIntent.current = intent
        setPrompt(result.data)
        return
      }
      if (step === 'restart') {
        // An empty open conversation chosen otherwise (memory, saving): nothing in it to lose, a new one as chosen.
        result = await startDialog(mode, { startNew: true, memory: wanted, saved })
        if (!result.ok) {
          setError(codeText(START_ERRORS, result.code, 'Не получилось начать разговор'))
          return
        }
      }
      openDialog(result.data, intent)
      navigated = true
    } catch (err) {
      setError(apiErrorText(err, {}, 'Не получилось начать разговор'))
    } finally {
      setLoading(false)
      release(navigated)
    }
  }

  /**
   * The chain after the sheet's «Продолжить» for someone with no session (PWA, Telegram): the account
   * is made and the consents recorded now, and the home that appears with the tabs continues the
   * original start — the same handover the native first screen uses, so the draft is not lost when
   * the screens swap. A failure keeps the draft and the error tells; the sheet is not reopened.
   */
  async function beginWithoutAccount(intent: StartIntent) {
    if (starting.current) return
    // A voice intention listens after the greeting: speech is let through by this tap.
    if (intent.listen) unlockSpeech()
    const startForm = telegram ? 'telegram_start' : 'device_start'
    track(AnalyticsEvent.CtaClicked, {
      cta: telegram ? 'start_telegram' : 'start_anonymous',
      placement: 'home',
    })
    starting.current = true
    setError('')
    setLoading(true)
    // The sign-in swaps the screens for the tabs, remounting home: the sheet closes first and the
    // chain waits for its close to finish, or the unmount of a half-open sheet leaves its backdrop
    // behind, blocking the screen.
    await closeConsentSheet()
    try {
      // The consent tick of the sheet covers memory, as on the web: the start turns it on.
      requestTalkOnHome({ rememberMemory: true, ...(intent.text ? { text: true } : {}) })
      if (telegram) {
        const outcome = await telegramLogin(telegramInitData() ?? '', true)
        if (!outcome.ok) {
          takeTalkRequest()
          reportForm('telegram_start', outcomeFromCode(outcome.code))
          setError(telegramLoginErrorText(outcome.code))
          return
        }
        await login(outcome.data.user, outcome.data.tokens, { consent: true })
        reportForm('telegram_start', 'success')
      } else {
        const { user, tokens } = await deviceLogin()
        await login(user, tokens, { consent: true })
        reportForm('device_start', 'success')
      }
      // The session swaps the screens for the tabs; the new home takes the request and starts.
    } catch (err) {
      takeTalkRequest()
      reportForm(startForm, outcomeFromError(err))
      setError(
        isDeviceLoginRefused(err) && !telegram
          ? DEVICE_LOGIN_REFUSED_TEXT
          : apiErrorText(err, {}, 'Не получилось начать разговор. Попробуй ещё раз'),
      )
    } finally {
      starting.current = false
      setLoading(false)
      setConsentSheetOpen(false)
    }
  }

  /**
   * «Продолжить» of the consent sheet: the agreements are recorded and the original start goes on
   * without another press. The confirmation stands for the session, so a failed chain shows the
   * error but does not reopen the sheet.
   */
  async function confirmConsent() {
    if (!sheetConsented || starting.current) return
    const intent = consentIntent.current
    consentConfirmed.current = true
    if (!auth.isAuthenticated) {
      await beginWithoutAccount(intent)
      return
    }
    // An account from before the current terms: only the agreements are recorded, then the start goes on.
    if (intent.listen) unlockSpeech()
    setError('')
    starting.current = true
    setLoading(true)
    const accepted = await acceptConsents()
    starting.current = false
    setLoading(false)
    setConsentSheetOpen(false)
    if (!accepted) {
      setError('Не получилось сохранить согласие. Попробуй ещё раз')
      return
    }
    void handleTalk({ intent })
  }

  // The diary's bridge: «Поговорить» there is this button, pressed from afar — always without text,
  // so a draft left in the field does not turn the diary's start into a text one.
  const talkRef = useRef(handleTalk)
  talkRef.current = handleTalk
  useEffect(() => {
    const onTalk = () => void talkRef.current({ intent: VOICE_INTENT })
    window.addEventListener(START_TALK_EVENT, onTalk)
    return () => window.removeEventListener(START_TALK_EVENT, onTalk)
  }, [])

  // The first screen's press (and the consent sheet's «Продолжить», which hands over the same way):
  // memory first if the person asked for it, then the conversation, with the choices made there.
  // A typed first message comes along too: it fills the field, so a failed start
  // keeps it, and turns the start into a text one.
  useEffect(() => {
    const request = fromWelcome.current
    if (!request) return
    // The request only exists when the agreements were confirmed on the way (the native gate or the
    // consent sheet): a failed start after the sign-in must not reopen the sheet.
    consentConfirmed.current = true
    void (async () => {
      let remembered = false
      if (request.rememberMemory) {
        const result = await enableMemory()
        if (result.ok) {
          remembered = result.data.enabled
          updateUser({ memoryEnabled: remembered })
        }
      }
      const intent: StartIntent = request.text ? TEXT_INTENT : VOICE_INTENT
      await talkRef.current({ chosen: chosenStart(remembered, false, false), intent })
    })().finally(() => (fromWelcome.current = null))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when home first appears
  }, [])

  /** "Продолжить": the same dialog, with the intention the start that found it had. */
  function continueDialog() {
    if (!prompt || starting.current) return
    const intent = pendingIntent.current
    pendingIntent.current = VOICE_INTENT
    if (intent.listen) unlockSpeech()
    starting.current = true
    answered.current = true
    track(AnalyticsEvent.DialogResumeChoice, { choice: 'continue' })
    openDialog(prompt, intent)
    setPrompt(null)
    release(true)
  }

  /** "Завершить и начать новый": the second start, the one that ends the open dialog. */
  async function startNew() {
    if (!prompt || starting.current) return
    const intent = pendingIntent.current
    pendingIntent.current = VOICE_INTENT
    if (intent.listen) unlockSpeech()
    starting.current = true
    answered.current = true
    setRenewing(true)
    let navigated = false
    try {
      const result = await startDialog(mode, { startNew: true, memory: wanted, saved: choice.saved })
      if (!result.ok) {
        if (result.code === StartDialogApiErrorCode.CONSENT_REQUIRED) {
          consentConfirmed.current = false
          updateUser({ consentVersion: null })
        }
        setError(codeText(START_ERRORS, result.code, 'Не получилось начать новый разговор'))
        return
      }
      track(AnalyticsEvent.DialogResumeChoice, { choice: 'new' })
      openDialog(result.data, intent)
      navigated = true
    } catch (err) {
      setError(apiErrorText(err, {}, 'Не получилось начать новый разговор'))
    } finally {
      // Either way the sheet goes: a failure is told under the talk button, where the person presses again.
      setPrompt(null)
      setRenewing(false)
      release(navigated)
    }
  }

  /** The button, a swipe or a tap outside: nothing is started or ended. Also called when the sheet closes after an answer. */
  function closeQuestion() {
    if (!answered.current) {
      answered.current = true
      pendingIntent.current = VOICE_INTENT
      track(AnalyticsEvent.DialogResumeChoice, { choice: 'dismissed' })
    }
    setPrompt(null)
  }

  /** With memory on, the one-off choice: the next conversation is not remembered. Memory itself is in the profile. */
  const memoryChoice = memoryEnabled === true && (
    <label className="rd-first-hello-incognito" data-testid="incognito">
      <input
        type="checkbox"
        className="rd-unsaved-check"
        checked={withoutMemory}
        onChange={(event) => {
          setWithoutMemory(event.target.checked)
          track(AnalyticsEvent.MemoryIncognitoToggled, { on: event.target.checked })
        }}
        data-testid="incognito-toggle"
      />
      Не запоминать этот разговор
    </label>
  )

  return (
    <Page name="home" onPageTabShow={loadMemory}>
      {/* slot="fixed" keeps the button outside .page-content: without it the button is
          absolutely positioned relative to the scroll container and would scroll away with
          the page the moment its content grows taller than the screen (design review). */}
      <SosButton slot="fixed" source="home" />
      {/* Day/night next to SOS; the native shell stays dark and renders nothing here. */}
      {signedIn && <ThemeSwitch slot="fixed" className="rd-theme-switch--corner" />}
      {/* A new person of the PWA/Telegram lands here without a session: the mark, the way to the
          sign-in and the theme switch on top, as on the first screen. */}
      {!signedIn && (
        <div className="rd-welcome-top">
          <button type="button" className="rd-logo-button" onClick={onLogoTap} aria-label="Рядом">
            <BrandMark size={36} />
          </button>
          <Button
            small
            outline
            round
            className="rd-welcome-login"
            disabled={loading}
            onClick={() => {
              track(AnalyticsEvent.CtaClicked, { cta: 'login', placement: 'home' })
              f7router.navigate('/login/')
            }}
            data-testid="have-account"
          >
            Войти
          </Button>
          <ThemeSwitch />
        </div>
      )}
      {firstScreen ? (
        // A new person of the PWA and Telegram: the sphere invites them to talk; the sheet asks for the
        // agreements only on a press, and nothing is sent before it.
        <FirstHello
          busy={loading}
          error={error}
          onVoice={() => void handleTalk({ intent: VOICE_INTENT })}
          onText={() => void handleTalk({ intent: TEXT_INTENT })}
        />
      ) : (
        /* One column on a phone; from WIDE the circle and the actions stand side by side. */
        <div className="rd-home">
          <div className="rd-home-orb">
            <Breathing size={isWide ? 280 : isShort ? 140 : 176} />
          </div>
          <div className="rd-home-main">
            <p className="rd-home-greeting">{greeting(auth.user?.name ?? null)}</p>
            <p className="rd-muted rd-home-lead">Я здесь и никуда не спешу. О чём хочется сказать?</p>

            <div className="rd-talk">
              {/* One press starts the conversation on the voice; the keyboard beside it starts it on the
                  text (the native shell is voice-only). No box and no suggestions. */}
              <div className="rd-home-start">
                <Button
                  fill
                  large
                  preloader
                  loading={loading}
                  disabled={loading}
                  onClick={() => void handleTalk()}
                  data-testid="home-start-voice"
                >
                  Начать разговор
                </Button>
                {!isNative() && (
                  <Button
                    large
                    outline
                    disabled={loading}
                    onClick={() => void handleTalk({ intent: TEXT_INTENT })}
                    aria-label="Начать текстом"
                    className="rd-first-hello-text"
                    data-testid="home-start-text"
                  >
                    <Icon f7="keyboard" size={20} aria-hidden="true" />
                  </Button>
                )}
              </div>
              {memoryChoice}
            </div>

            {error && (
              <p className="rd-form-error" data-testid="form-error">
                {error}
              </p>
            )}

            {/* Keep the documents visible even while the consent gate is closed. */}
            <div className="rd-welcome-foot" data-testid="home-foot">
              <ConsentNote />
              <p className="rd-fineprint rd-welcome-sos">В опасной ситуации звони 112.</p>
              {/* As on the web: a line, not a card, so that the foot stays in view above the tabs. */}
              <button
                type="button"
                className="rd-inline-link rd-home-people-link ph-no-capture"
                onClick={() => openSos({ source: 'home' })}
                data-testid="home-people"
              >
                Люди рядом&nbsp;— линии помощи
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PWA and Telegram only: the agreements at the first action, over home; the native shell
          keeps its gate on the first screen and never renders this. */}
      <ConsentSheet
        opened={consentSheetOpen}
        busy={loading}
        telegram={telegram}
        checked={sheetConsented}
        onCheckedChange={setSheetConsented}
        onContinue={() => void confirmConsent()}
        onClose={() => {
          // The fully-closed event resolves the wait of the chain that closed the sheet itself.
          consentSheetClosed.current?.()
          if (!loading) setConsentSheetOpen(false)
        }}
      />
      <ResumeDialogSheet
        opened={prompt !== null}
        busy={renewing}
        // A returned conversation keeps its choices: the new-conversation choices apply only to a new one.
        note={
          wanted === DialogMemoryMode.Off && prompt?.memoryMode !== DialogMemoryMode.Off
            ? '«Без памяти» будет только у нового разговора: этот продолжится с памятью.'
            : undefined
        }
        onContinue={continueDialog}
        onStartNew={() => void startNew()}
        onClose={closeQuestion}
      />
    </Page>
  )
}
