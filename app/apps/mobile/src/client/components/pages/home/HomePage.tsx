import { Button, Icon, Page, f7 } from 'framework7-react'
import type { Router } from 'framework7/types'
import { useCallback, useEffect, useRef, useState } from 'react'
import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { chosenStart, nextStartStep } from '@ryadom/client-core/dialog-start'
import { rememberUnsaved, UNSAVED_HINT, UNSAVED_LABEL } from '@ryadom/client-core/unsaved'
import { DialogMode, StartDialogApiErrorCode, type StartDialogApiResponse } from '@ryadom/contracts/api/dialogs'
import { DialogMemoryMode, type MemoryApiResponse } from '@ryadom/contracts/api/memory'
import { memoryInUse, needsMemoryConsent } from '@ryadom/client-core/memory'
import { apiErrorText, codeText, getMemory, startDialog } from '../../../lib/api'
import { enableMemory } from '../../../lib/memory'
import { START_TALK_EVENT, takeTalkRequest, type TalkRequest } from '../../../lib/nav'
import { unlockSpeech } from '../../../lib/voice/speech'
import { useAuth } from '../../../lib/store'
import { SHORT_QUERY, useMediaQuery, WIDE_QUERY } from '../../../lib/viewport'
import Breathing from '../../Breathing'
import ConsentNote from '../../ConsentNote'
import Switch from '../../Switch'
import { SosButton, openSos } from '../../SosSheet'
import MemoryConsentSheet from '../profile/MemoryConsentSheet'
import ResumeDialogSheet from './ResumeDialogSheet'

/**
 * Home screen: the breathing circle and one large talk button. If the person left a
 * conversation unfinished (with something said in it), the talk button waits for their answer:
 * continue it, end it and begin a new one, or close the question and stay here.
 *
 * With memory off, "Запоминать важное" turns it on here (with the consent sheet when the consent was never
 * given); with memory on, a switch "Без памяти" under the button holds the next conversation without it,
 * and after a conversation the card "Я запомнил" shows up here. None of them is needed to start.
 *
 * There are no modes to pick: one conversation, which starts as `vent` (the server ignores the mode).
 */

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
  const { auth, updateUser } = useAuth()
  const isWide = useMediaQuery(WIDE_QUERY)
  const isShort = useMediaQuery(SHORT_QUERY)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  /** Set at once on a press, unlike `loading`: two taps in one tick would both see that as still false. */
  const starting = useRef(false)
  /** The unfinished conversation a start found: the question is open over it. */
  const [prompt, setPrompt] = useState<StartDialogApiResponse | null>(null)
  /** "End it and begin a new one" is in flight. */
  const [renewing, setRenewing] = useState(false)
  /** The question was answered (or its request is out): closing the sheet is then no "dismissed". */
  const answered = useRef(false)

  const userId = auth.user?.id ?? null
  const memoryEnabled = auth.user?.memoryEnabled
  /** "Без памяти" for the next conversation; it goes back to off once a conversation starts. */
  const [withoutMemory, setWithoutMemory] = useState(false)
  /** "Не сохранять этот разговор" for the next conversation, a choice of its own; it goes back to off once a conversation starts. */
  const [unsaved, setUnsaved] = useState(false)
  /** The invitation to memory: the sheet with the offer, then the consent sheet after "Включить". */
  const [invite, setInvite] = useState<'consent' | null>(null)
  const [invitedMemory, setInvitedMemory] = useState<MemoryApiResponse | null>(null)
  const [consentBusy, setConsentBusy] = useState(false)
  const [consentError, setConsentError] = useState('')
  const choice = chosenStart(memoryEnabled, withoutMemory, unsaved)
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
        setInvitedMemory(memory)
      })
      .catch(() => {})
  }, [userId, updateUser])

  useEffect(() => {
    loadMemory()
  }, [loadMemory])

  /** "Запоминать важное": the consent sheet when the consent was never given for this text, otherwise straight on. */
  function turnMemoryOn() {
    setConsentError('')
    if (needsMemoryConsent(invitedMemory)) setInvite('consent')
    else void acceptConsent()
  }

  async function acceptConsent() {
    setConsentBusy(true)
    setConsentError('')
    const result = await enableMemory()
    setConsentBusy(false)
    if (!result.ok) {
      setConsentError(result.text)
      return
    }
    updateUser({ memoryEnabled: invitedMemory !== null && memoryInUse({ ...invitedMemory, ...result.data }) })
    setInvite(null)
    f7.toast.create({ text: 'Память включена', closeTimeout: 2500 }).open()
  }

  function release(navigated: boolean) {
    if (navigated) setTimeout(() => (starting.current = false), NAVIGATION_LOCK_MS)
    else starting.current = false
  }

  /** A start that says memory is off for the person is believed at once; "on" is left to `loadMemory`. */
  function learnMemory(data: StartDialogApiResponse) {
    if (data.memoryEnabled === false && memoryEnabled !== false) updateUser({ memoryEnabled: false })
  }

  function openDialog(data: StartDialogApiResponse) {
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
        // The button says "talk": the conversation opens on the voice screen and already listens.
        listen: true,
      },
    })
    setWithoutMemory(false)
    setUnsaved(false)
  }

  async function handleTalk(chosen: ReturnType<typeof chosenStart> = choice) {
    if (starting.current) return
    const { memory: wanted, saved } = chosen
    // The conversation opens on the voice and the sphere speaks first: speech is let through by this tap.
    unlockSpeech()
    starting.current = true
    setError('')
    setLoading(true)
    let navigated = false
    try {
      let result = await startDialog(mode, { memory: wanted, saved })
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
        // Something was said in the conversation left open. Nothing changes until the person answers.
        answered.current = false
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
      openDialog(result.data)
      navigated = true
    } catch (err) {
      setError(apiErrorText(err, {}, 'Не получилось начать разговор'))
    } finally {
      setLoading(false)
      release(navigated)
    }
  }

  // The diary's bridge: «Поговорить» there is this button, pressed from afar.
  const talkRef = useRef(handleTalk)
  talkRef.current = handleTalk
  useEffect(() => {
    const onTalk = () => void talkRef.current()
    window.addEventListener(START_TALK_EVENT, onTalk)
    return () => window.removeEventListener(START_TALK_EVENT, onTalk)
  }, [])

  // The first screen's press: memory first if the person asked for it, then the conversation, with the
  // choices made there.
  useEffect(() => {
    const request = fromWelcome.current
    if (!request) return
    void (async () => {
      let remembered = false
      if (request.rememberMemory) {
        const result = await enableMemory()
        if (result.ok) {
          remembered = result.data.enabled
          updateUser({ memoryEnabled: remembered })
        }
      }
      await talkRef.current(chosenStart(remembered, false, !request.saved))
    })().finally(() => (fromWelcome.current = null))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when home first appears
  }, [])

  /** "Продолжить": the same dialog, as a start without a question used to open it. */
  function continueDialog() {
    if (!prompt || starting.current) return
    unlockSpeech()
    starting.current = true
    answered.current = true
    track(AnalyticsEvent.DialogResumeChoice, { choice: 'continue' })
    openDialog(prompt)
    setPrompt(null)
    release(true)
  }

  /** "Завершить и начать новый": the second start, the one that ends the open dialog. */
  async function startNew() {
    if (!prompt || starting.current) return
    unlockSpeech()
    starting.current = true
    answered.current = true
    setRenewing(true)
    let navigated = false
    try {
      const result = await startDialog(mode, { startNew: true, memory: wanted, saved: choice.saved })
      if (!result.ok) {
        if (result.code === StartDialogApiErrorCode.CONSENT_REQUIRED) updateUser({ consentVersion: null })
        setError(codeText(START_ERRORS, result.code, 'Не получилось начать новый разговор'))
        return
      }
      track(AnalyticsEvent.DialogResumeChoice, { choice: 'new' })
      openDialog(result.data)
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
      track(AnalyticsEvent.DialogResumeChoice, { choice: 'dismissed' })
    }
    setPrompt(null)
  }

  return (
    <Page name="home" onPageTabShow={loadMemory}>
      {/* slot="fixed" keeps the button outside .page-content: without it the button is
          absolutely positioned relative to the scroll container and would scroll away with
          the page the moment its content grows taller than the screen (design review). */}
      <SosButton slot="fixed" source="home" />
      {/* One column on a phone; from WIDE the circle and the actions stand side by side. */}
      <div className="rd-home">
        <div className="rd-home-orb">
          <Breathing size={isWide ? 280 : isShort ? 188 : 232} />
        </div>
        <div className="rd-home-main">
          <p className="rd-home-greeting">{greeting(auth.user?.name ?? null)}</p>
          <p className="rd-muted rd-home-lead">Я здесь и никуда не спешу. О чём хочется сказать?</p>

          <div className="rd-talk">
            <Button
              fill
              large
              preloader
              loading={loading}
              disabled={loading}
              onClick={() => void handleTalk()}
            >
              Поговорить
            </Button>
            {/* Memory off: the way to turn it on is here, not in a sheet that interrupts. */}
            {memoryEnabled !== true && invitedMemory?.available === true && (
              <div className="rd-incognito" data-testid="memory-switch">
                <span className="rd-incognito-text">
                  <span className="rd-incognito-title">Запоминать важное</span>
                  <span className="rd-caption">Чтобы не начинать каждый раз с нуля. По желанию</span>
                </span>
                {/* Remounted when the sheet opens or closes: a declined consent puts the switch back. */}
                <Switch key={String(invite)} checked={false} onChange={(on) => on && turnMemoryOn()} />
              </div>
            )}
            {/* Only while memory is on: without it every conversation is "without memory" anyway. */}
            {memoryEnabled === true && (
              <div className="rd-incognito" data-testid="incognito">
                <span className="rd-incognito-text">
                  <span className="rd-incognito-title">Без памяти</span>
                  <span className="rd-caption">
                    {withoutMemory
                      ? 'Этот разговор я не запомню'
                      : 'Следующий разговор не попадёт в память'}
                  </span>
                </span>
                <Switch
                  checked={withoutMemory}
                  onChange={(on) => {
                    setWithoutMemory(on)
                    track(AnalyticsEvent.MemoryIncognitoToggled, { on })
                  }}
                />
              </div>
            )}
            {/* Always there, memory or no memory: this conversation is kept out of the journal, the recaps and the analytics. */}
            <label className="rd-incognito rd-unsaved" data-testid="unsaved">
              <span className="rd-incognito-text">
                <span className="rd-incognito-title">{UNSAVED_LABEL}</span>
                <span className="rd-caption">{UNSAVED_HINT}</span>
              </span>
              <input
                type="checkbox"
                className="rd-unsaved-check"
                data-testid="unsaved-toggle"
                checked={unsaved}
                onChange={(event) => setUnsaved(event.target.checked)}
              />
            </label>
          </div>

          {error && (
            <p className="rd-form-error" data-testid="form-error">
              {error}
            </p>
          )}

          <div className="rd-home-people">
            <div className="rd-note">
              <span className="rd-note-tile">
                <Icon f7="person_2" size={22} className="rd-note-icon" />
              </span>
              <div className="rd-note-body">
                <p className="rd-note-title">Люди рядом</p>
                <p className="rd-note-text">
                  Линии помощи, а со временем&nbsp;— группы поддержки и специалисты. Разговор со мной не
                  заменяет живых людей.
                </p>
                <Button small round outline className="ph-no-capture" onClick={() => openSos({ source: 'home' })}>
                  Посмотреть
                </Button>
              </div>
            </div>
          </div>

          {/* The foot of home, as on the first screen: what starting a conversation agrees to, with the terms and the policy. */}
          <div className="rd-welcome-foot" data-testid="home-foot">
            <ConsentNote />
            <p className="rd-fineprint rd-welcome-sos">В опасной ситуации звони 112.</p>
          </div>
        </div>
      </div>

      <ResumeDialogSheet
        opened={prompt !== null}
        busy={renewing}
        // A returned conversation keeps the choices it began with: "Без памяти" and "Не сохранять" apply only to a new one.
        note={
          unsaved && prompt?.saved === false
            ? undefined
            : unsaved
              ? '«Не сохранять» будет только у нового разговора: этот продолжится как обычно.'
              : wanted === DialogMemoryMode.Off && prompt?.memoryMode !== DialogMemoryMode.Off
                ? '«Без памяти» будет только у нового разговора: этот продолжится с памятью.'
                : undefined
        }
        onContinue={continueDialog}
        onStartNew={() => void startNew()}
        onClose={closeQuestion}
      />
      <MemoryConsentSheet
        opened={invite === 'consent'}
        kind="consent"
        busy={consentBusy}
        error={consentError}
        onAccept={() => void acceptConsent()}
        onClose={() => !consentBusy && setInvite(null)}
      />
    </Page>
  )
}
