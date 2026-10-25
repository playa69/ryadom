import { Button, Icon, Page } from 'framework7-react'
import type { Router } from 'framework7/types'
import { useCallback, useEffect, useRef, useState } from 'react'
import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { chosenMemoryMode, nextStartStep } from '@ryadom/client-core/dialog-start'
import { DialogMode, StartDialogApiErrorCode, type StartDialogApiResponse } from '@ryadom/contracts/api/dialogs'
import { DialogMemoryMode } from '@ryadom/contracts/api/memory'
import { memoryInUse } from '@ryadom/client-core/memory'
import { apiErrorText, codeText, getMemory, startDialog } from '../../../lib/api'
import { START_TALK_EVENT } from '../../../lib/nav'
import { unlockSpeech } from '../../../lib/voice/speech'
import { useAuth } from '../../../lib/store'
import { SHORT_QUERY, useMediaQuery, WIDE_QUERY } from '../../../lib/viewport'
import Breathing from '../../Breathing'
import Switch from '../../Switch'
import { SosButton, openSos } from '../../SosSheet'
import { memoryCard } from '../../../lib/memory'
import MemoryCard from './MemoryCard'
import ResumeDialogSheet from './ResumeDialogSheet'

/**
 * Home screen: the breathing circle, one large talk button and the modes. If the person left a
 * conversation unfinished (with something said in it), the talk button waits for their answer:
 * continue it, end it and begin a new one, or close the question and stay here.
 *
 * With memory on, a switch "Без памяти" under the button holds the next conversation without it, and
 * after a conversation the card "Я запомнил" shows up here.
 *
 * In v0 only the venting mode works. The other modes exist in the contract, but enabling them
 * before the agent supports them would be a promise the product cannot keep.
 */

const MODES: Array<{ id: DialogMode; label: string; hint: string; icon: string; ready: boolean }> = [
  {
    id: DialogMode.Vent,
    label: 'Выговориться',
    hint: 'Просто слушаю, без советов',
    icon: 'heart',
    ready: true,
  },
  {
    id: DialogMode.Chat,
    label: 'Поболтать',
    hint: 'Лёгкий разговор ни о чём',
    icon: 'chat_bubble',
    ready: false,
  },
  {
    id: DialogMode.Journal,
    label: 'Дневник',
    hint: 'Вопросы, чтобы лучше понять себя',
    icon: 'book',
    ready: false,
  },
  {
    id: DialogMode.RitualEvening,
    label: 'Вечерний ритуал',
    hint: 'Дыхание, слова, маленькое действие',
    icon: 'moon',
    ready: false,
  },
]

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
  const [mode, setMode] = useState<DialogMode>(DialogMode.Vent)
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
  const wanted = chosenMemoryMode(memoryEnabled, withoutMemory)

  // Whether to offer "Без памяти" is asked whenever home comes into view: the person's switch and
  // whether the server uses memory at all can both change elsewhere. A failure leaves what was known.
  const loadMemory = useCallback(() => {
    if (!userId) return
    getMemory()
      .then((memory) => updateUser({ memoryEnabled: memoryInUse(memory) }))
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

  function openDialog(data: StartDialogApiResponse) {
    // A new conversation makes the card of the previous one old news.
    memoryCard.close()
    f7router.navigate(`/dialog/${data.dialogId}/`, {
      props: {
        greeting: data.greeting,
        resumed: data.resumed,
        sinceLastDialogHours: data.sinceLastDialogHours,
        memoryMode: data.memoryMode ?? DialogMemoryMode.On,
        memoryEnabled: data.memoryEnabled,
        // The button says "talk": the conversation opens on the voice screen and already listens.
        listen: true,
      },
    })
    setWithoutMemory(false)
  }

  async function handleTalk() {
    if (starting.current) return
    // The conversation opens on the voice and the sphere speaks first: speech is let through by this tap.
    unlockSpeech()
    starting.current = true
    setError('')
    setLoading(true)
    let navigated = false
    try {
      let result = await startDialog(mode, { memory: wanted })
      if (!result.ok) {
        // The server has no agreement on record for this account: forget what was cached, and the
        // app's gate takes the person through the first screen.
        if (result.code === StartDialogApiErrorCode.CONSENT_REQUIRED) updateUser({ consentVersion: null })
        setError(codeText(START_ERRORS, result.code, 'Не получилось начать разговор'))
        return
      }
      learnMemory(result.data)
      const step = nextStartStep(result.data, wanted)
      if (step === 'ask') {
        // Something was said in the conversation left open. Nothing changes until the person answers.
        answered.current = false
        setPrompt(result.data)
        return
      }
      if (step === 'restart') {
        // An empty open conversation in the other memory mode: nothing in it to lose, a new one in the chosen mode.
        result = await startDialog(mode, { startNew: true, memory: wanted })
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
      const result = await startDialog(mode, { startNew: true, memory: wanted })
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
            {/* Only while memory is on: without it every conversation is "without memory" anyway. */}
            {memoryEnabled === true && (
              <div className="rd-incognito" data-testid="incognito">
                <span className="rd-incognito-text">
                  <span className="rd-incognito-title">Без памяти</span>
                  <span className="rd-caption">
                    {withoutMemory
                      ? 'Этот разговор я не запомню, а сам он удалится через сутки'
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
          </div>

          <MemoryCard owner={userId} />

          <div className="rd-modes">
            {MODES.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`rd-mode${mode === item.id ? ' rd-mode--active' : ''}`}
                disabled={!item.ready}
                onClick={() => setMode(item.id)}
              >
                <span className="rd-mode-icon">
                  <Icon f7={item.icon} size={22} />
                </span>
                <span className="rd-mode-text">
                  <span className="rd-mode-label">{item.label}</span>
                  <span className="rd-mode-hint">{item.hint}</span>
                </span>
                {/* `title` alone is a tooltip, and touch input never fires hover, so on a phone a row
                  that is not ready explained nothing (design review). Visible text works everywhere. */}
                {item.ready ? (
                  <Icon f7="chevron_right" size={16} />
                ) : (
                  <span className="rd-mode-soon">скоро</span>
                )}
              </button>
            ))}
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
        </div>
      </div>

      <ResumeDialogSheet
        opened={prompt !== null}
        busy={renewing}
        // A returned conversation keeps the mode it began in: "Без памяти" applies only to a new one.
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
