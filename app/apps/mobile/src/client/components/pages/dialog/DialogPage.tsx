import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent, sizeClass } from '@ryadom/analytics/events'
import { Icon, Message, Messages, Navbar, Page, Preloader, f7 } from 'framework7-react'
import type { Router } from 'framework7/types'
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { shouldWatchMemoryChanges } from '@ryadom/client-core/memory'
import { DialogWsErrorCode, type DialogSummaryApiResponse } from '@ryadom/contracts/api/dialogs'
import { InputLimit } from '@ryadom/contracts/api/limits'
import { DialogMemoryMode } from '@ryadom/contracts/api/memory'
import { ANONYMOUS_RETENTION_DAYS } from '@ryadom/contracts/api/policy'
import { reportMicFailure, reportVoiceProblem } from '../../../lib/analytics'
import {
  createDialogSocket,
  type DialogSocket,
  type DialogMessageView,
  type DialogSocketState,
} from '../../../lib/dialog-socket'
import { getDialog } from '../../../lib/api'
import { journal } from '../../../lib/journal'
import { watchMemoryCard } from '../../../lib/memory'
import { openRoute } from '../../../lib/nav'
import { useAuth } from '../../../lib/store'
import {
  isCaptureSupported,
  MicrophoneDeniedError,
  startCapture,
  type VoiceCapture,
} from '../../../lib/voice/capture'
import {
  HANDS_FREE_HINT,
  HANDS_FREE_KEY,
  pausedHint,
  readHandsFree,
  type MicPause,
} from '../../../lib/voice/hands-free'
import { VoicePlayer } from '../../../lib/voice/player'
import { ReplyVoice, unlockSpeech } from '../../../lib/voice/speech'
import {
  isTurnDetectionSupported,
  TurnDetector,
  watchTurns,
  type TurnEvent,
} from '../../../lib/voice/turn-detector'
import { openSos } from '../../SosSheet'
import Breathing from '../../Breathing'
import VoiceOrb, { type OrbState } from '../../VoiceOrb'
import DialogEndSheet from './DialogEndSheet'

/**
 * Conversation screen. Voice is the main way to talk: the sphere is the interface. Hands-free (the
 * default), the microphone stays open and the person just speaks: the turn detector finds where a turn
 * starts and ends and lets them talk over the agent, and a tap pauses the microphone. Without it (the
 * setting is off, or the WebView has no detector) the person taps to speak and taps again to finish.
 * Text is one tap away and shows the whole feed with the input field, but it is the second way.
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

/**
 * Without a first word from the agent the sphere must not think forever. A long voice turn takes the
 * recognition a while, so after one the wait grows by the length of the turn.
 */
const REPLY_WAIT_MS = 20_000

/** The speaker would not start (a suspended or refused audio context): the agent cannot be heard. */
const onPlaybackFailed = (): void => reportVoiceProblem('playback_failed')

export default function DialogPage({
  f7router,
  dialogId,
  greeting,
  resumed,
  sinceLastDialogHours,
  memoryMode: startedMemoryMode,
  memoryEnabled,
  listen,
}: {
  f7router: Router.Router
  dialogId: string
  greeting?: string | null
  /** The server returned a conversation that was already open instead of starting a new one. */
  resumed?: boolean
  sinceLastDialogHours?: number | null
  /** `off`: the conversation is held "without memory". Unknown when opened other than from home. */
  memoryMode?: DialogMemoryMode
  /** Whether the person's memory was on when the conversation started. */
  memoryEnabled?: boolean
  /** Opened by the talk button on home: start listening as soon as the connection is up. */
  listen?: boolean
}) {
  const { auth } = useAuth()
  const user = auth.user
  const [memoryMode, setMemoryMode] = useState<DialogMemoryMode | undefined>(startedMemoryMode)

  // Opened other than from home: the dialog itself says whether it is held without memory.
  useEffect(() => {
    if (startedMemoryMode !== undefined) return
    let cancelled = false
    getDialog(dialogId)
      .then((result) => {
        if (!cancelled && result.ok) setMemoryMode(result.data.memoryMode)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [dialogId, startedMemoryMode])
  const [messages, setMessages] = useState<DialogMessageView[]>([])
  const [state, setState] = useState<DialogSocketState>('connecting')
  const [mode, setMode] = useState<Mode>('voice')
  const [draft, setDraft] = useState('')
  const [recording, setRecording] = useState(false)
  /** Read once: the setting lives in the profile, and a conversation keeps the mode it began in. */
  const [handsFree] = useState(() => readHandsFree(HANDS_FREE_KEY) && isTurnDetectionSupported())
  /** Hands-free: the microphone is open and the detector listens for turns. */
  const [micOpen, setMicOpen] = useState(false)
  /** Hands-free: why the microphone is off after having been on; null before it first opens. */
  const [paused, setPaused] = useState<MicPause | null>(null)
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
  /** A turn is being sent: the person has the floor. A ref, because the detector's loop reads it. */
  const recordingRef = useRef(false)
  const detector = useRef(new TurnDetector())
  const stopWatching = useRef<(() => void) | null>(null)
  /** The agent is thinking or answering: silence now is not the person being idle. */
  const busy = useRef(false)
  /** The person's turn is with the agent and no reply has begun: what the server's voice outage is put down to. */
  const waitingForReply = useRef(false)
  const turnStartedAt = useRef(0)
  const replyWait = useRef(REPLY_WAIT_MS)
  const modeRef = useRef<Mode>(mode)
  const listenOnReady = useRef(listen === true)
  const caption = useRef<HTMLDivElement>(null)

  useEffect(() => {
    modeRef.current = mode
  }, [mode])

  // Once per conversation opened, not per render; `resumed` is what the server said when it started it.
  useEffect(() => {
    track(AnalyticsEvent.DialogScreenOpened, { resumed: resumed === true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogId])

  const markRecording = useCallback((on: boolean) => {
    recordingRef.current = on
    setRecording(on)
    if (!on) setHearing('')
  }, [])

  /**
   * Hands-free: the microphone off. `turn` says what becomes of a turn in progress: `send` gives it to
   * the agent (the person said it, so it is answered), `drop` forgets it (the conversation is ending).
   */
  const closeMic = useCallback(
    async (reason: MicPause | null, turn: 'send' | 'drop') => {
      stopWatching.current?.()
      stopWatching.current = null
      const active = capture.current
      capture.current = null
      if (recordingRef.current) {
        markRecording(false)
        if (turn === 'send') {
          socket.current?.endAudio()
          replyWait.current = REPLY_WAIT_MS + (performance.now() - turnStartedAt.current)
          setAwaitingReply(true)
        }
      }
      setMicOpen(false)
      if (active) setPaused(reason)
      await active?.stop()
    },
    [markRecording],
  )

  useEffect(() => {
    const voicePlayer = new VoicePlayer()
    player.current = voicePlayer
    const replyVoice = new ReplyVoice()
    voice.current = replyVoice
    /** The agent begins speaking a message: on the voice its frames play, and our own voice gives way to it. */
    const startAgentSpeech = (messageId: string) => {
      replyVoice.agentSpoke(messageId)
      // The person is already talking (they began while the agent was thinking): it is not spoken over
      // them. The frames stay muted and the agent is asked to stop, as when they talk over it.
      if (recordingRef.current) {
        voicePlayer.stop()
        socket.current?.interruptSpeech()
        return
      }
      // Someone who is reading is not spoken to: the frames of this speech are dropped.
      if (modeRef.current === 'voice') voicePlayer.begin()
    }
    // Home asked for the voice, so the agent's greeting is about to arrive as audio. The tap that led here
    // still counts as the person's gesture on desktop and in WebViews; the player must be awake before the frames.
    if (listen) void voicePlayer.unlock().catch(onPlaybackFailed)

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
            // Hands-free comes back paused: a tap after the reconnect takes the microphone back.
            void closeMic('manual', 'drop')
          }
          // The agent has started to answer (or the line is gone): nothing is awaited any more.
          if (next !== 'ready') setAwaitingReply(false)
        },
        onMessages: setMessages,
        onSpeech: (messageId, phase) =>
          phase === 'start' ? startAgentSpeech(messageId) : replyVoice.agentSpeechEnded(messageId),
        onTranscript: (text, final) => {
          // A voice turn the agent heard: only how long it was, in three sizes, never what was said.
          if (final && text.trim()) {
            track(AnalyticsEvent.DialogMessageSent, { input: 'voice', size: sizeClass(text.length) })
          }
          setHearing(final ? '' : text)
          // Nothing was heard (a cough, the agent's own echo): no answer is coming, so nothing is awaited.
          if (final && !text) setAwaitingReply(false)
        },
        onAudio: (speech) => voicePlayer.enqueue(speech),
        onSafety: (_level, text, hotlines) => openSos({ text, hotlines, source: 'safety_frame' }),
        onEnded: (result) => setSummary(result),
        onError: (code, message) => {
          if (code === DialogWsErrorCode.VOICE_UNAVAILABLE) {
            // The server does not say whether it was recognition or speech: a turn in flight points at recognition.
            reportVoiceProblem(
              recordingRef.current || waitingForReply.current ? 'asr_unavailable' : 'tts_unavailable',
            )
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
      stopWatching.current?.()
      stopWatching.current = null
      void capture.current?.stop()
      capture.current = null
      replyVoice.dispose()
      void voicePlayer.dispose()
    }
  }, [dialogId, greeting, closeMic])

  const connected = state === 'ready' || state === 'streaming'

  // A reply that never starts (a silent recording, an agent that dropped the turn) would leave the
  // sphere thinking for good.
  useEffect(() => {
    if (!awaitingReply) return
    const timer = setTimeout(() => setAwaitingReply(false), replyWait.current)
    return () => clearTimeout(timer)
  }, [awaitingReply])

  useEffect(() => {
    busy.current = awaitingReply || state === 'streaming'
    waitingForReply.current = awaitingReply
  }, [awaitingReply, state])

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
    () =>
      (recordingRef.current ? capture.current?.level() : undefined) ??
      Math.max(player.current?.level() ?? 0, voice.current?.level() ?? 0),
    [],
  )

  /** Silence, the agent's recorded speech included: its frames in the queue and the rest of it on the server. */
  const hush = useCallback(() => {
    voice.current?.cancel()
    player.current?.stop()
    socket.current?.interruptSpeech()
  }, [])

  const startListening = useCallback(
    async (automatic: boolean) => {
      if (micStarting.current || capture.current) return
      unlockSpeech()
      // A voice screen without a microphone is useless: when nobody asked for the microphone just now,
      // say so softly and move to the text it falls back to, instead of a dialog on arrival.
      const fallBack = (text: string) => {
        setMode('text')
        f7.toast.create({ text, closeTimeout: 4000 }).open()
      }
      if (!isCaptureSupported()) {
        reportVoiceProblem('unsupported')
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
        await player.current?.unlock().catch(onPlaybackFailed)
        // The worklet is in public/: next to index.html, which under a PWA prefix is not the root.
        const started = await startCapture((frame) => socket.current?.sendAudio(frame), {
          workletUrl: `${import.meta.env.BASE_URL}voice-worklet.js`,
        })
        // The connection may have dropped, or the person moved to the text, while the permission
        // prompt was open.
        if (!socket.current?.isConnected() || modeRef.current !== 'voice') {
          await started.stop()
          return
        }
        capture.current = started
        socket.current.startAudio(started.sampleRate)
        markRecording(true)
        setAwaitingReply(false)
      } catch (error) {
        void reportMicFailure(error)
        const text = error instanceof MicrophoneDeniedError ? MIC_DENIED_TEXT : MIC_FAILED_TEXT
        if (automatic) fallBack(text)
        else f7.dialog.alert(text, 'Голос')
      } finally {
        micStarting.current = false
      }
    },
    [markRecording],
  )

  /** The person finished a turn: the utterance goes to the agent, which should now answer. */
  const finishUtterance = useCallback(async () => {
    const active = capture.current
    if (!active) return
    capture.current = null
    markRecording(false)
    socket.current?.endAudio()
    replyWait.current = REPLY_WAIT_MS
    setAwaitingReply(true)
    await active.stop()
  }, [markRecording])

  /** Microphone off without an utterance: the conversation is being ended, no answer is wanted. */
  const dropListening = useCallback(() => {
    const active = capture.current
    if (!active) return
    capture.current = null
    markRecording(false)
    void active.stop()
  }, [markRecording])

  /** A turn found by the detector: it is sent while the person speaks, and a turn over the agent silences it. */
  const onTurn = useCallback(
    (event: TurnEvent) => {
      const active = capture.current
      if (!active) return
      if (event.type === 'idle') {
        void closeMic('idle', 'send')
        return
      }
      if (event.type === 'start') {
        if (!socket.current?.isConnected()) {
          detector.current.reset(performance.now())
          return
        }
        if (event.bargeIn) hush()
        socket.current.startAudio(active.sampleRate)
        active.open()
        turnStartedAt.current = performance.now()
        markRecording(true)
        setAwaitingReply(false)
        return
      }
      if (!recordingRef.current) return
      active.close()
      markRecording(false)
      socket.current?.endAudio()
      replyWait.current = REPLY_WAIT_MS + (performance.now() - turnStartedAt.current)
      setAwaitingReply(true)
    },
    [closeMic, hush, markRecording],
  )

  /**
   * Hands-free: the microphone opens for the whole voice session and the detector takes the turns.
   * `automatic`: nobody tapped just now (home asked for the voice). A tap while the agent speaks means
   * the person wants the floor, so it silences the agent.
   */
  const openMic = useCallback(
    async (automatic: boolean) => {
      if (micStarting.current || capture.current) return
      unlockSpeech()
      micStarting.current = true
      try {
        if (!automatic) hush()
        await player.current?.unlock().catch(onPlaybackFailed)
        const started = await startCapture((frame) => socket.current?.sendAudio(frame), {
          workletUrl: `${import.meta.env.BASE_URL}voice-worklet.js`,
          gated: true,
        })
        if (!socket.current?.isConnected() || modeRef.current !== 'voice') {
          await started.stop()
          return
        }
        capture.current = started
        detector.current.reset(performance.now())
        const agentSpeaking = () => Boolean(player.current?.speaking || voice.current?.speaking)
        stopWatching.current = watchTurns(detector.current, {
          level: () => started.level(),
          agentLevel: () => Math.max(player.current?.level() ?? 0, voice.current?.level() ?? 0),
          agentSpeaking,
          busy: () => busy.current || agentSpeaking(),
          onEvent: onTurn,
        })
        setMicOpen(true)
        setPaused(null)
      } catch (error) {
        void reportMicFailure(error)
        const text = error instanceof MicrophoneDeniedError ? MIC_DENIED_TEXT : MIC_FAILED_TEXT
        if (automatic) {
          setMode('text')
          f7.toast.create({ text, closeTimeout: 4000 }).open()
        } else {
          f7.dialog.alert(text, 'Голос')
        }
      } finally {
        micStarting.current = false
      }
    },
    [hush, onTurn],
  )

  // Hands-free never listens in the background: a hidden tab or an app sent away closes the microphone
  // (what was being said is still answered), and only a tap brings it back, which iOS requires anyway.
  useEffect(() => {
    if (!handsFree) return
    const onVisibility = () => {
      if (document.visibilityState === 'hidden' && capture.current) void closeMic('background', 'send')
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [handsFree, closeMic])

  // The talk button on home: the greeting is said aloud, and listening starts as soon as the line is up and
  // the greeting is said. The agent voices it itself; if it does not, the screen's own voice reads the text.
  // The microphone waits either way: an open microphone would hear the greeting as the person's words.
  useEffect(() => {
    if (!connected || !listenOnReady.current) return
    listenOnReady.current = false
    void (async () => {
      if (greeting) await voice.current?.greet(greeting, () => player.current?.drained() ?? Promise.resolve())
      if (modeRef.current !== 'voice') return
      if (handsFree) await openMic(true)
      else await startListening(true)
    })()
  }, [connected, greeting, handsFree, openMic, startListening])

  /** A tap on the sphere or the microphone: hands-free it pauses and resumes, otherwise it starts and ends a turn. */
  function toggleListening() {
    if (handsFree) {
      if (micOpen) void closeMic('manual', 'send')
      else void openMic(false)
      return
    }
    if (recording) void finishUtterance()
    else void startListening(false)
  }

  async function showText() {
    track(AnalyticsEvent.DialogVoiceToggled, { enabled: false })
    hush()
    if (handsFree) await closeMic(null, 'send')
    else await finishUtterance()
    // At once, not after the next render: whatever waits on the greeting must see the text already chosen.
    modeRef.current = 'text'
    setMode('text')
  }

  function showVoice() {
    track(AnalyticsEvent.DialogVoiceToggled, { enabled: true })
    setMode('voice')
    // Choosing the voice is asking to speak: no second tap.
    modeRef.current = 'voice'
    if (handsFree) void openMic(false)
    else void startListening(false)
  }

  const canSend = connected && draft.trim().length > 0

  const send = useCallback(() => {
    const text = draft.trim()
    if (!text) return
    // Only how long it is, in three sizes: the message itself never leaves the conversation.
    track(AnalyticsEvent.DialogMessageSent, { input: 'text', size: sizeClass(text.length) })
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
    track(AnalyticsEvent.DialogEndSheetOpened)
    hush()
    if (handsFree) void closeMic('manual', 'drop')
    else dropListening()
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
    // What the conversation added to memory shows up on home as "Я запомнил" once the agent is done.
    if (
      user &&
      shouldWatchMemoryChanges({ memoryMode, memoryEnabled: memoryEnabled ?? user.memoryEnabled })
    ) {
      void watchMemoryCard(dialogId, user.id)
    }
    const text = summary?.title
      ? `Забираешь с собой: ${summary.title}`
      : 'Разговор завершён. Я рядом, когда понадоблюсь.'
    const keepsConversations = user?.email === null || user?.isEmailConfirmed === false
    if (!keepsConversations) {
      f7.dialog.alert(text, 'Спасибо, что поговорил(а)', () => f7router.back())
    } else {
      // A finished conversation is the moment an address has something to give: this one is kept.
      f7.dialog
        .create({
          title: 'Спасибо, что поговорил(а)',
          text: `${text}<br><br>Без почты разговоры хранятся ${ANONYMOUS_RETENTION_DAYS} дней после последнего визита, и войти с другого телефона нельзя. Привяжи почту, чтобы не потерять их.`,
          buttons: [
            {
              text: user?.email === null ? 'Привязать почту' : 'Подтвердить почту',
              onClick: () => {
                f7router.back()
                openRoute('/profile/link-email/')
              },
            },
            { text: 'ОК', onClick: () => f7router.back() },
          ],
        })
        .open()
    }
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
  let hint =
    statusText ??
    {
      connecting: '',
      idle: 'Нажми на шар и говори',
      listening: 'Слушаю. Нажми, когда закончишь',
      thinking: 'Думаю…',
      speaking: 'Нажми, чтобы перебить',
    }[orb]
  // Hands-free, before the microphone first opens (the greeting is still being said) a tap is what opens
  // it, so the tap words above are right; after that the microphone is either listening or paused.
  if (!statusText && handsFree && orb !== 'connecting') {
    if (micOpen) hint = HANDS_FREE_HINT[orb]
    else if (paused) hint = pausedHint(paused)
  }
  // Hands-free the button pauses the microphone and takes it back; it no longer ends a turn.
  const mic = handsFree
    ? {
        label: micOpen ? 'Поставить микрофон на паузу' : 'Включить микрофон',
        icon: micOpen ? 'pause_fill' : 'mic_fill',
      }
    : { label: recording ? 'Остановить запись' : 'Говорить', icon: recording ? 'stop_fill' : 'mic_fill' }

  // A long reply streams in below the visible lines: keep the newest words in view.
  useEffect(() => {
    const element = caption.current
    if (element) element.scrollTop = element.scrollHeight
  }, [subtitle, mode])

  return (
    <Page name="dialog" className="rd-dialog-page rd-no-tabbar ph-no-capture">
      <Navbar backLink="Назад" title="Разговор">
        <button
          slot="right"
          type="button"
          className="rd-banner-action rd-navbar-sos ph-no-capture"
          onClick={() => openSos({ source: 'dialog' })}
        >
          SOS
        </button>
      </Navbar>

      {memoryMode === DialogMemoryMode.Off && (
        <div className="rd-incognito-mark" role="note" data-testid="dialog-incognito">
          <Icon f7="eye_slash" size={16} />
          <span>
            <b>Без памяти.</b> Этот разговор я не запомню, а сам он удалится через сутки
          </span>
        </div>
      )}

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
              aria-label={mic.label}
              onClick={toggleListening}
            >
              <Icon f7={mic.icon} size={30} />
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
          // Neither the takeaway nor the value on the scale is reported, only whether each was given.
          track(AnalyticsEvent.DialogEndSubmitted, {
            has_takeaway: takeaway !== null,
            gave_tension: tension !== null,
            skipped: takeaway === null && tension === null,
          })
          socket.current?.end(takeaway, tension)
          // The summary arrives as an `ended` frame. If the agent stays silent or the socket is
          // already closed, we end it ourselves after two seconds: nobody should get stuck here.
          setTimeout(() => setSummary((current) => (current === undefined ? null : current)), 2000)
        }}
      />
    </Page>
  )
}
