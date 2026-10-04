import { Icon, Message, Messages, Navbar, Page, Preloader, f7 } from 'framework7-react'
import type { Router } from 'framework7/types'
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { DialogWsErrorCode, type DialogSummaryApiResponse } from '@ryadom/contracts/api/dialogs'
import { InputLimit } from '@ryadom/contracts/api/limits'
import {
  createDialogSocket,
  type DialogSocket,
  type DialogMessageView,
  type DialogSocketState,
} from '../../../lib/dialog-socket'
import { journal } from '../../../lib/journal'
import {
  isCaptureSupported,
  MicrophoneDeniedError,
  startCapture,
  type VoiceCapture,
} from '../../../lib/voice/capture'
import { VoicePlayer } from '../../../lib/voice/player'
import { ReplyVoice, unlockSpeech } from '../../../lib/voice/speech'
import { openSos } from '../../SosSheet'
import Breathing from '../../Breathing'
import VoiceOrb, { type OrbState } from '../../VoiceOrb'
import DialogEndSheet from './DialogEndSheet'

/**
 * Conversation screen. Voice is the main way to talk: the sphere is the
 * interface, and the person taps it to speak and taps again to finish. Text is one tap away and
 * shows the whole feed with the input field, but it is the second way, not the first.
 *
 * The screen owns the socket: it opens on entry and closes on leaving. Reconnects and the message
 * queue live inside DialogSocket.
 */

type Mode = 'voice' | 'text'

const STATE_TEXT: Partial<Record<DialogSocketState, string>> = {
  connecting: 'Соединяюсь…',
  reconnecting: 'Связь прервалась — восстанавливаю…',
  failed: 'Не получается соединиться. Попробуй войти в разговор заново',
}

const MIC_UNSUPPORTED_TEXT = 'Здесь микрофон недоступен. Можно писать текстом.'
const MIC_DENIED_TEXT = 'Микрофон не разрешён. Разреши его в настройках — или пиши текстом.'
const MIC_FAILED_TEXT = 'Не получилось включить микрофон. Можно писать текстом.'

/** Without a first word from the agent the sphere must not think forever. */
const REPLY_WAIT_MS = 20_000

export default function DialogPage({
  f7router,
  dialogId,
  greeting,
  sinceLastDialogHours,
  listen,
}: {
  f7router: Router.Router
  dialogId: string
  greeting?: string | null
  sinceLastDialogHours?: number | null
  /** Opened by the talk button on home: start listening as soon as the connection is up. */
  listen?: boolean
}) {
  const [messages, setMessages] = useState<DialogMessageView[]>([])
  const [state, setState] = useState<DialogSocketState>('connecting')
  const [mode, setMode] = useState<Mode>('voice')
  const [draft, setDraft] = useState('')
  const [recording, setRecording] = useState(false)
  const [hearing, setHearing] = useState('')
  /** The person has finished speaking or typing and the agent has not started to answer yet. */
  const [awaitingReply, setAwaitingReply] = useState(false)
  /** The agent's voice is audible: the text can already be complete while the audio still plays. */
  const [voiceOut, setVoiceOut] = useState(false)
  const [endOpened, setEndOpened] = useState(false)
  const [summary, setSummary] = useState<DialogSummaryApiResponse | null | undefined>(undefined)

  const socket = useRef<DialogSocket | null>(null)
  const player = useRef<VoicePlayer | null>(null)
  /** The sphere's own voice for what the agent does not speak itself: the greeting, a reply without speech. */
  const voice = useRef<ReplyVoice | null>(null)
  const capture = useRef<VoiceCapture | null>(null)
  const micStarting = useRef(false)
  const modeRef = useRef<Mode>(mode)
  const listenOnReady = useRef(listen === true)
  const caption = useRef<HTMLDivElement>(null)

  useEffect(() => {
    modeRef.current = mode
  }, [mode])

  useEffect(() => {
    const voicePlayer = new VoicePlayer()
    player.current = voicePlayer
    const replyVoice = new ReplyVoice()
    voice.current = replyVoice
    /** The agent begins speaking a message: on the voice its frames play, and our own voice gives way to it. */
    const startAgentSpeech = (messageId: string) => {
      // Someone who is reading is not spoken to: the frames of this speech are dropped.
      if (modeRef.current === 'voice') voicePlayer.begin()
      replyVoice.agentSpoke(messageId)
    }
    // Home asked for the voice, so the agent's greeting is about to arrive as audio. The tap that led here
    // still counts as the person's gesture on desktop and in WebViews; the player must be awake before the frames.
    if (listen) void voicePlayer.unlock().catch(() => undefined)

    const dialog = createDialogSocket(
      dialogId,
      {
        onState: (next) => {
          setState(next)
          // Frames sent while the connection is down are lost and the gateway would never hear
          // `audio_start` again: a microphone left on would record into the void.
          if (next !== 'ready' && next !== 'streaming') {
            voicePlayer.stop()
            replyVoice.cancel()
            const active = capture.current
            if (active) {
              capture.current = null
              setRecording(false)
              setHearing('')
              void active.stop()
            }
          }
          // The agent has started to answer (or the line is gone): nothing is awaited any more.
          if (next !== 'ready') setAwaitingReply(false)
        },
        onMessages: (list) => {
          // A reply is read out only to someone who is on the voice and not talking themselves.
          replyVoice.observe(list, modeRef.current === 'voice' && !capture.current)
          setMessages(list)
        },
        onSpeech: (messageId, phase) =>
          phase === 'start' ? startAgentSpeech(messageId) : replyVoice.agentSpeechEnded(messageId),
        onTranscript: (text, final) => setHearing(final ? '' : text),
        onAudio: (frame) => voicePlayer.enqueue(frame),
        onSafety: (_level, text, hotlines) => openSos({ text, hotlines }),
        onEnded: (result) => setSummary(result),
        onError: (code, message) => {
          if (code === DialogWsErrorCode.VOICE_UNAVAILABLE) {
            f7.toast
              .create({ text: 'Голос сейчас недоступен — можно писать текстом', closeTimeout: 3000 })
              .open()
            return
          }
          if (code === DialogWsErrorCode.AGENT_UNAVAILABLE) {
            f7.toast
              .create({ text: 'Сейчас я не могу ответить. Линии помощи — по кнопке SOS', closeTimeout: 4000 })
              .open()
            return
          }
          if (code === DialogWsErrorCode.RATE_LIMITED || code === DialogWsErrorCode.MESSAGE_TOO_LONG) {
            f7.toast.create({ text: message, closeTimeout: 2500 }).open()
          }
        },
      },
      // The greeting from the dialog start: the socket may take a moment to open, and the screen
      // must not be empty.
      greeting,
    )
    socket.current = dialog
    dialog.connect()

    return () => {
      dialog.close()
      void capture.current?.stop()
      replyVoice.dispose()
      void voicePlayer.dispose()
    }
  }, [dialogId, greeting])

  const connected = state === 'ready' || state === 'streaming'

  // A reply that never starts (a silent recording, an agent that dropped the turn) would leave the
  // sphere thinking for good.
  useEffect(() => {
    if (!awaitingReply) return
    const timer = setTimeout(() => setAwaitingReply(false), REPLY_WAIT_MS)
    return () => clearTimeout(timer)
  }, [awaitingReply])

  // The player's queue is not React state, so the screen asks it a few times a second.
  useEffect(() => {
    if (mode !== 'voice') return
    const timer = setInterval(
      () => setVoiceOut(Boolean(player.current?.speaking || voice.current?.speaking)),
      200,
    )
    return () => clearInterval(timer)
  }, [mode])

  /** Whose voice moves the sphere: the person's while listening, the agent's (recorded or ours) otherwise. */
  const level = useCallback(
    () => capture.current?.level() ?? Math.max(player.current?.level() ?? 0, voice.current?.level() ?? 0),
    [],
  )

  const startListening = useCallback(async (automatic: boolean) => {
    if (micStarting.current || capture.current) return
    unlockSpeech()
    // A voice screen without a microphone is useless: when nobody asked for the microphone just now,
    // say so softly and move to the text it falls back to, instead of a dialog on arrival.
    const fallBack = (text: string) => {
      setMode('text')
      f7.toast.create({ text, closeTimeout: 4000 }).open()
    }
    if (!isCaptureSupported()) {
      if (automatic) fallBack(MIC_UNSUPPORTED_TEXT)
      else f7.dialog.alert(MIC_UNSUPPORTED_TEXT, 'Голос')
      return
    }
    micStarting.current = true
    try {
      // Talking over the agent cuts it off.
      player.current?.stop()
      voice.current?.cancel()
      socket.current?.interruptSpeech()
      // The player is unlocked by the person's own tap (an iOS requirement). A refusal here only
      // means the agent will not be heard; it must not block the microphone.
      await player.current?.unlock().catch(() => undefined)
      const started = await startCapture((frame) => socket.current?.sendAudio(frame))
      // The connection may have dropped, or the person moved to the text, while the permission
      // prompt was open.
      if (!socket.current?.isConnected() || modeRef.current !== 'voice') {
        await started.stop()
        return
      }
      capture.current = started
      socket.current.startAudio(started.sampleRate)
      setRecording(true)
      setAwaitingReply(false)
    } catch (error) {
      const text = error instanceof MicrophoneDeniedError ? MIC_DENIED_TEXT : MIC_FAILED_TEXT
      if (automatic) fallBack(text)
      else f7.dialog.alert(text, 'Голос')
    } finally {
      micStarting.current = false
    }
  }, [])

  /** The person finished a turn: the utterance goes to the agent, which should now answer. */
  const finishUtterance = useCallback(async () => {
    const active = capture.current
    if (!active) return
    capture.current = null
    setRecording(false)
    setHearing('')
    socket.current?.endAudio()
    setAwaitingReply(true)
    await active.stop()
  }, [])

  /** Microphone off without an utterance: the conversation is being ended, no answer is wanted. */
  const dropListening = useCallback(() => {
    const active = capture.current
    if (!active) return
    capture.current = null
    setRecording(false)
    setHearing('')
    void active.stop()
  }, [])

  // The talk button on home: the greeting is said aloud, and listening starts as soon as the line is up and
  // the greeting is said. The agent voices it itself; if it does not, the screen's own voice reads the text.
  // The microphone waits either way: an open microphone would hear the greeting as the person's words.
  useEffect(() => {
    if (!connected || !listenOnReady.current) return
    listenOnReady.current = false
    void (async () => {
      if (greeting) await voice.current?.greet(greeting, () => player.current?.drained() ?? Promise.resolve())
      if (modeRef.current === 'voice') await startListening(true)
    })()
  }, [connected, greeting, startListening])

  function toggleListening() {
    if (recording) void finishUtterance()
    else void startListening(false)
  }

  /** Silence, the agent's recorded speech included: its frames in the queue and the rest of it on the server. */
  function hush() {
    voice.current?.cancel()
    player.current?.stop()
    socket.current?.interruptSpeech()
  }

  async function showText() {
    hush()
    await finishUtterance()
    // At once, not after the next render: whatever waits on the greeting must see the text already chosen.
    modeRef.current = 'text'
    setMode('text')
  }

  function showVoice() {
    setMode('voice')
    // Choosing the voice is asking to speak: no second tap.
    modeRef.current = 'voice'
    void startListening(false)
  }

  const canSend = connected && draft.trim().length > 0

  const send = useCallback(() => {
    const text = draft.trim()
    if (!text) return
    socket.current?.sendMessage(text)
    setDraft('')
    setAwaitingReply(true)
    // Typing is quiet: nothing here wakes the player, so the agent's speech stays out of the text.
  }, [draft])

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends and Shift+Enter inserts a newline, as in any messenger.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  }

  function openEnd() {
    hush()
    dropListening()
    setEndOpened(true)
  }

  /*
   * The summary is shown once, wherever it came from: an `ended` frame from the agent, or the
   * fallback timer if the socket had already closed. `summary === undefined` means the conversation
   * has not been ended yet; `null` means it ended with no summary.
   */
  useEffect(() => {
    if (summary === undefined) return
    setEndOpened(false)
    // The journal lives on another tab; on a wide screen its list is visible right away.
    void journal.refresh()
    f7.dialog.alert(
      summary?.title
        ? `Забираешь с собой: ${summary.title}`
        : 'Разговор завершён. Я рядом, когда понадоблюсь.',
      'Спасибо, что поговорил(а)',
      () => f7router.back(),
    )
    // summary is the only dependency: this must fire exactly on the transition out of undefined.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary])

  const statusText = STATE_TEXT[state]
  const lastReply = [...messages].reverse().find((message) => message.role === 'assistant')

  let orb: OrbState
  if (state === 'connecting' || state === 'reconnecting' || state === 'failed') orb = 'connecting'
  else if (recording) orb = 'listening'
  else if (voiceOut || (state === 'streaming' && lastReply?.text)) orb = 'speaking'
  else if (state === 'streaming' || awaitingReply) orb = 'thinking'
  else orb = 'idle'

  // What is shown under the sphere: the person's words as soon as they are recognized, otherwise the
  // agent's latest reply (the greeting stays until the person speaks). While the agent thinks the
  // old reply would be stale, so there is nothing. The whole feed is in the text mode.
  const subtitle = orb === 'thinking' ? '' : recording && hearing ? hearing : (lastReply?.text ?? '')
  const hint =
    statusText ??
    {
      connecting: '',
      idle: 'Нажми на шар и говори',
      listening: 'Слушаю. Нажми, когда закончишь',
      thinking: 'Думаю…',
      speaking: 'Нажми, чтобы перебить',
    }[orb]

  // A long reply streams in below the visible lines: keep the newest words in view.
  useEffect(() => {
    const element = caption.current
    if (element) element.scrollTop = element.scrollHeight
  }, [subtitle, mode])

  return (
    <Page name="dialog" className="rd-dialog-page rd-no-tabbar">
      <Navbar backLink="Назад" title="Разговор">
        <button
          slot="right"
          type="button"
          className="rd-banner-action rd-navbar-sos"
          onClick={() => openSos()}
        >
          SOS
        </button>
      </Navbar>

      {sinceLastDialogHours !== null && sinceLastDialogHours !== undefined && sinceLastDialogHours >= 24 && (
        <div className="rd-dialog-status">
          Нас не было {Math.round(sinceLastDialogHours / 24)}&nbsp;дн. Расскажи, что изменилось.
        </div>
      )}

      {mode === 'voice' ? (
        <div className="rd-voice">
          {/* The whole stage is the target: the sphere is large, and the person need not aim. The
              microphone button below is the same action for those who look for a button. */}
          <div className="rd-voice-stage" role="presentation" onClick={toggleListening}>
            <VoiceOrb state={orb} level={level} />
          </div>

          <div ref={caption} className="rd-voice-caption" data-testid="voice-caption">
            {subtitle}
          </div>
          <p className="rd-voice-hint" role="status">
            {hint}
          </p>

          <div className="rd-voice-controls">
            <button
              type="button"
              className="rd-voice-side"
              aria-label="Писать текстом"
              onClick={() => void showText()}
            >
              <span className="rd-voice-side-icon">
                <Icon f7="keyboard" size={22} />
              </span>
              <span aria-hidden="true">Текстом</span>
            </button>
            <button
              type="button"
              className={`rd-voice-mic${recording ? ' rd-voice-mic--on' : ''}`}
              aria-label={recording ? 'Остановить запись' : 'Говорить'}
              onClick={toggleListening}
            >
              <Icon f7={recording ? 'stop_fill' : 'mic_fill'} size={30} />
            </button>
            <button
              type="button"
              className="rd-voice-side"
              aria-label="Завершить разговор"
              disabled={state === 'ended'}
              onClick={openEnd}
            >
              <span className="rd-voice-side-icon">
                <Icon f7="checkmark_alt" size={22} />
              </span>
              <span aria-hidden="true">Завершить</span>
            </button>
          </div>
        </div>
      ) : (
        <>
          {messages.length === 0 && state === 'connecting' && (
            <div className="rd-home">
              <Breathing size={140} label="вдох · выдох" />
              <Preloader />
            </div>
          )}

          <Messages>
            {messages.map((message) => (
              <Message
                key={message.id}
                type={message.role === 'user' ? 'sent' : 'received'}
                className={message.role === 'assistant' ? 'rd-message-assistant' : undefined}
              >
                <span slot="text" className={message.streaming ? 'rd-typing' : undefined}>
                  {message.text}
                </span>
              </Message>
            ))}
          </Messages>

          {statusText && <div className="rd-dialog-status">{statusText}</div>}

          <div className="rd-dialog-bar">
            <textarea
              placeholder="Напиши, что происходит"
              value={draft}
              maxLength={InputLimit.MessageMax}
              rows={1}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
            />
            {/* With nothing typed the button on the right goes back to the voice, as in the voice
                assistants people already know; with text it sends. */}
            {draft.trim() ? (
              <button
                type="button"
                className="rd-icon-button rd-icon-button--primary"
                aria-label="Отправить"
                disabled={!canSend}
                onClick={send}
              >
                <Icon f7="arrow_up" size={20} />
              </button>
            ) : (
              <button
                type="button"
                className="rd-icon-button rd-icon-button--voice"
                aria-label="Говорить голосом"
                onClick={showVoice}
              >
                <Icon f7="mic_fill" size={20} />
              </button>
            )}
          </div>

          <div className="rd-dialog-end">
            <button type="button" className="rd-banner-action" onClick={openEnd} disabled={state === 'ended'}>
              Завершить разговор
            </button>
          </div>
        </>
      )}

      <DialogEndSheet
        opened={endOpened}
        onClose={() => setEndOpened(false)}
        onSubmit={(takeaway, tension) => {
          socket.current?.end(takeaway, tension)
          // The summary arrives as an `ended` frame. If the agent stays silent or the socket is
          // already closed, we end it ourselves after two seconds: nobody should get stuck here.
          setTimeout(() => setSummary((current) => (current === undefined ? null : current)), 2000)
        }}
      />
    </Page>
  )
}
