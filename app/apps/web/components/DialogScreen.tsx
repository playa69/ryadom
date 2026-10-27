'use client'

import { ArrowDown, CircleCheck, EyeOff, Share2 } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent, sizeClass } from '@ryadom/analytics/events'
import {
  DialogApiErrorCode,
  DialogWsErrorCode,
  type DialogSummaryApiResponse,
} from '@ryadom/contracts/api/dialogs'
import { apiErrorText } from '@ryadom/client-core/errors'
import { RECAP_ERROR_TEXT } from '@ryadom/client-core/recaps'
import { shouldWatchMemoryChanges } from '@ryadom/client-core/memory'
import { DialogMemoryMode } from '@ryadom/contracts/api/memory'
import type {
  DialogMessageView,
  DialogSocket,
  DialogSocketHandlers,
  DialogSocketState,
} from '@ryadom/client-core/dialog-socket'
import {
  isCaptureSupported,
  MicrophoneDeniedError,
  startCapture,
  type VoiceCapture,
} from '@ryadom/client-core/voice/capture'
import {
  HANDS_FREE_HINT,
  pausedHint,
  readHandsFree,
  type MicPause,
} from '@ryadom/client-core/voice/hands-free'
import { VoicePlayer } from '@ryadom/client-core/voice/player'
import { ReplyVoice, unlockSpeech } from '@ryadom/client-core/voice/speech'
import {
  isTurnDetectionSupported,
  TurnDetector,
  watchTurns,
  type TurnEvent,
} from '@ryadom/client-core/voice/turn-detector'
import { Button } from '@ryadom/ui/components/button'
import type { OrbState } from '@ryadom/ui/components/voice-orb'
import { cn } from '@ryadom/ui/lib/utils'
import { ANONYMOUS_RETENTION_DAYS } from '@ryadom/contracts/api/policy'
import { micProblemReason, trackVoiceProblem, useOnceFor } from '@/lib/analytics'
import { useAuth, useClient } from '@/lib/auth'
import { appPath } from '@/lib/base-path'
import { watchMemoryCard } from '@/lib/memory'
import { WEB_HANDS_FREE_KEY } from '@/lib/storage-keys'
import { AppHeader } from './AppHeader'
import Breathing from './Breathing'
import ChatComposer from './ChatComposer'
import DialogAlert from './DialogAlert'
import DialogEndSheet, { type EndRecapSource } from './DialogEndSheet'
import ShareDialogModal from './ShareDialogModal'
import DialogFeed from './DialogFeed'
import DialogVoice from './DialogVoice'
import { BUTTON, COLUMN } from './controls'
import { useNotice, useNoticePlacement } from './Notice'
import { useSos } from './Sos'
import { claimFreshStart, readDialogStart, takeDialogHandoff } from './dialog-start'
import { initialDialogView, rememberDialogView, type DialogView } from './dialog-view'
import { useStickToEnd } from './dialog-scroll'

/**
 * The conversation. Voice is the main way to talk: the screen opens on the sphere. Hands-free (the
 * default) the microphone stays open and the person just speaks: the turn detector finds where a turn
 * starts and ends and lets them talk over the agent, and a tap pauses the microphone. Without it (the
 * setting is off, or the browser has no detector) the person taps to speak and taps again to finish.
 * The text face is one tap away
 * and is a classic chat page: the header with "end the conversation", the streaming feed in a centered
 * column and the input box docked under it. The screen owns the socket: it opens on entry and is
 * closed on leaving. Reconnects and the outgoing queue live inside DialogSocket.
 *
 * The page itself scrolls (the header and the dock are sticky), which is what dialog-scroll.ts watches.
 */

const STATE_TEXT: Partial<Record<DialogSocketState, string>> = {
  connecting: 'Соединяюсь…',
  reconnecting: 'Связь прервалась — восстанавливаю…',
  failed: 'Не получается соединиться. Попробуй войти в разговор заново',
}

/** Without an answer from the agent the person must not be stuck on the closing step. */
const END_FALLBACK_MS = 2000

const MIC_UNSUPPORTED_TEXT = 'Здесь микрофон недоступен. Можно писать текстом.'
const MIC_DENIED_TEXT = 'Микрофон не разрешён. Разреши его в настройках — или пиши текстом.'
const MIC_FAILED_TEXT = 'Не получилось включить микрофон. Можно писать текстом.'
const MIC_OFF_TEXT = 'Связь прервалась — микрофон выключен'
const END_FAILED_TEXT = 'Не получилось завершить разговор. Попробуй ещё раз'

/**
 * Without a first word from the agent the sphere must not think forever. A long voice turn takes the
 * recognition a while, so after one the wait grows by the length of the turn.
 */
const REPLY_WAIT_MS = 20_000

interface AlertState {
  title: string
  text: string
  /** The closing summary: dismissing it leaves the conversation. */
  leaves: boolean
}

function greetingMessages(greeting: string | null | undefined): DialogMessageView[] {
  return greeting ? [{ id: 'greeting', role: 'assistant', text: greeting }] : []
}

export default function DialogScreen({ dialogId }: { dialogId: string }) {
  const client = useClient()
  const { user } = useAuth()
  const router = useRouter()
  const notify = useNotice()
  // The input box sits where the default toast stack would, so toasts go under the header.
  useNoticePlacement('top')
  const { openSos } = useSos()

  const start = readDialogStart(dialogId)
  // A dialog started from home says whether the server resumed one; any other way in (a reload, the
  // history, a link) is a return to a conversation that already exists.
  useOnceFor(dialogId, () => track(AnalyticsEvent.DialogScreenOpened, { resumed: start?.resumed ?? true }))
  const [messages, setMessages] = useState<DialogMessageView[]>(() => greetingMessages(start?.greeting))
  const [state, setState] = useState<DialogSocketState>('connecting')
  const [view, setView] = useState<DialogView>(() => initialDialogView(dialogId))
  const [sharing, setSharing] = useState(false)
  const [recording, setRecording] = useState(false)
  /** Read once: the setting lives in the profile, and a conversation keeps the mode it began in. */
  const [handsFree] = useState(() => readHandsFree(WEB_HANDS_FREE_KEY) && isTurnDetectionSupported())
  /** Hands-free: the microphone is open and the detector listens for turns. */
  const [micOpen, setMicOpen] = useState(false)
  /** Hands-free: why the microphone is off after having been on; null before it first opens. */
  const [paused, setPaused] = useState<MicPause | null>(null)
  /** What the recognition has heard so far in the current turn. */
  const [hearing, setHearing] = useState('')
  /** The person has finished speaking or typing and the agent has not started to answer yet. */
  const [awaitingReply, setAwaitingReply] = useState(false)
  /** The agent's voice is audible: the text can already be complete while the audio still plays. */
  const [voiceOut, setVoiceOut] = useState(false)
  const [endOpen, setEndOpen] = useState(false)
  const [ending, setEnding] = useState(false)
  const [endError, setEndError] = useState('')
  // «Подводить итог автоматически»: read when the end sheet opens; null until then.
  const [recapEnabled, setRecapEnabled] = useState<boolean | null>(null)
  const [alert, setAlert] = useState<AlertState | null>(null)
  const [missing, setMissing] = useState(false)
  /** `off`: held "without memory". From home it comes with the start; any other way in, with the dialog. */
  const [memoryMode, setMemoryMode] = useState<DialogMemoryMode | undefined>(start?.memoryMode)
  /** What the end needs to decide whether to wait for the card "Я запомнил". */
  const memoryWatch = useRef({
    memoryMode,
    memoryEnabled: start?.memoryEnabled ?? user?.memoryEnabled,
    userId: user?.id,
  })
  useEffect(() => {
    memoryWatch.current = {
      memoryMode,
      memoryEnabled: start?.memoryEnabled ?? user?.memoryEnabled,
      userId: user?.id,
    }
  })

  const socket = useRef<DialogSocket | null>(null)
  const capture = useRef<VoiceCapture | null>(null)
  const player = useRef<VoicePlayer | null>(null)
  /** The sphere's own voice for what the agent does not speak itself: the greeting, a reply without speech. */
  const voice = useRef<ReplyVoice | null>(null)
  const micStarting = useRef(false)
  /** A turn is being sent: the person has the floor. A ref, because the detector's loop reads it. */
  const recordingRef = useRef(false)
  const detector = useRef(new TurnDetector())
  const stopWatching = useRef<(() => void) | null>(null)
  /** The agent is thinking or answering: silence now is not the person being idle. */
  const busy = useRef(false)
  const turnStartedAt = useRef(0)
  const replyWait = useRef(REPLY_WAIT_MS)
  const viewRef = useRef(view)
  const finished = useRef(false)
  const endTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /**
   * What the person typed on home, waiting for a socket that lives long enough to carry it. A ref,
   * not state: the effect below runs twice in development (Strict Mode) and the first socket is
   * closed before it ever connects, so the text has to outlive it. Cleared once a socket is ready.
   */
  const draft = useRef<string | null>(null)
  /** The person pressed the microphone on home: start listening as soon as the socket is ready. */
  const listenOnReady = useRef(false)

  const dock = useRef<HTMLDivElement>(null)
  // Coming back to the text must land on the end of the feed, as a new message does.
  const feedVersion = useMemo(() => ({ messages, view }), [messages, view])
  const { hasNew, follow, jumpToEnd } = useStickToEnd(feedVersion, view === 'text' ? dock : undefined)

  useEffect(() => {
    viewRef.current = view
    rememberDialogView(dialogId, view)
  }, [dialogId, view])

  const markRecording = useCallback((on: boolean) => {
    recordingRef.current = on
    setRecording(on)
    if (!on) setHearing('')
  }, [])

  /**
   * The microphone off, with no answer wanted for a turn in progress (the conversation is ending, or the
   * line dropped). Hands-free comes back paused: a tap takes the microphone back.
   */
  const stopRecording = useCallback(async () => {
    stopWatching.current?.()
    stopWatching.current = null
    const active = capture.current
    capture.current = null
    markRecording(false)
    setMicOpen(false)
    if (active) {
      setPaused('manual')
      await active.stop()
    }
  }, [markRecording])

  /** Hands-free: the microphone off, and what the person was saying still goes to the agent. */
  const pauseMic = useCallback(
    async (reason: MicPause) => {
      if (!capture.current) return
      if (recordingRef.current) {
        socket.current?.endAudio()
        replyWait.current = REPLY_WAIT_MS + (performance.now() - turnStartedAt.current)
        setAwaitingReply(true)
      }
      await stopRecording()
      setPaused(reason)
    },
    [stopRecording],
  )

  /** The summary is shown once, wherever it came from: the `ended` frame, the REST answer or the fallback timer. */
  const finish = useCallback(
    (summary: DialogSummaryApiResponse | null) => {
      if (finished.current) return
      finished.current = true
      clearTimeout(endTimer.current)
      setEndOpen(false)
      setEnding(false)
      void stopRecording()
      voice.current?.cancel()
      // What the conversation added to memory shows up on home as "Я запомнил" once the agent is done.
      const { userId, ...memory } = memoryWatch.current
      if (userId && shouldWatchMemoryChanges(memory)) void watchMemoryCard(client, dialogId, userId)
      setAlert({
        title: 'Спасибо, что поговорил(а)',
        text:
          (summary?.title
            ? `Забираешь с собой: ${summary.title}`
            : 'Разговор завершён. Я рядом, когда понадоблюсь.') +
          (summary?.recapStatus === 'pending'
            ? ' Итог разговора появится в журнале через минуту.'
            : summary?.recapStatus === 'ready'
              ? ' Итог разговора сохранён в журнале.'
              : ''),
        leaves: true,
      })
    },
    [client, dialogId, stopRecording],
  )

  // The socket handlers outlive renders; they read the latest helpers through here.
  const greeting = start?.greeting ?? null
  const latest = useRef({ notify, openSos, startListening, openMic, onTurn, greeting })
  useEffect(() => {
    latest.current = { notify, openSos, startListening, openMic, onTurn, greeting }
  })

  useEffect(() => {
    let cancelled = false
    let opened: DialogSocket | null = null

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
      if (viewRef.current === 'voice') voicePlayer.begin()
    }

    // Taken once, here: a browser "back" to this dialog later must not send the text again.
    const handoff = takeDialogHandoff(dialogId)
    if (handoff?.draft) {
      draft.current = handoff.draft
      // Taken exactly once, so this is the one place the first message from home is counted.
      track(AnalyticsEvent.DialogMessageSent, { input: 'text', size: sizeClass(handoff.draft.length) })
    }
    if (handoff?.listen) {
      listenOnReady.current = true
      // The agent's greeting is about to arrive as audio. The tap that led here still counts as the person's
      // gesture, and the player must be awake before the frames.
      void voicePlayer.unlock().catch(() => trackVoiceProblem('playback_failed'))
    }

    const handlers: DialogSocketHandlers = {
      onState: (next) => {
        setState(next)
        // From here on the socket owns the message (it resends until the server acknowledges it).
        if (next === 'ready' || next === 'streaming') draft.current = null
        // Frames sent while the connection is down are lost, and the gateway would never hear
        // `audio_start` again: a microphone that stays on would record into the void. Off it goes,
        // and so does the agent's speech that is still queued.
        if (next !== 'ready' && next !== 'streaming') {
          voicePlayer.stop()
          replyVoice.cancel()
          if (capture.current) {
            void stopRecording()
            if (next !== 'ended') latest.current.notify(MIC_OFF_TEXT, 'info')
          }
        }
        // The agent has started to answer (or the line is gone): nothing is awaited any more.
        if (next !== 'ready') setAwaitingReply(false)
      },
      onMessages: setMessages,
      onSpeech: (messageId, phase) =>
        phase === 'start' ? startAgentSpeech(messageId) : replyVoice.agentSpeechEnded(messageId),
      onTranscript: (text, final) => {
        setHearing(final ? '' : text)
        // Nothing was heard (a cough, the agent's own echo): no answer is coming, so nothing is awaited.
        if (final && !text) setAwaitingReply(false)
        // The words are never reported: only that a spoken message went out, and how long it was.
        if (final && text) {
          track(AnalyticsEvent.DialogMessageSent, { input: 'voice', size: sizeClass(text.length) })
        }
      },
      onAudio: (speech) => voicePlayer.enqueue(speech),
      // Not reported from here on purpose: the server already counts this signal (safety_signal), with no
      // person attached; a second count from a signed-in screen would only risk pointing at who was in crisis.
      onSafety: (_level, text, hotlines) => latest.current.openSos({ text, hotlines }),
      onEnded: (result) => finish(result),
      onError: (code, message) => {
        if (code === DialogWsErrorCode.VOICE_UNAVAILABLE) {
          void stopRecording()
          latest.current.notify('Голос сейчас недоступен — можно писать текстом', 'info')
        } else if (code === DialogWsErrorCode.AGENT_UNAVAILABLE) {
          latest.current.notify('Сейчас я не могу ответить. Линии помощи — по кнопке SOS', 'error')
        } else if (code === DialogWsErrorCode.RATE_LIMITED || code === DialogWsErrorCode.MESSAGE_TOO_LONG) {
          latest.current.notify(message, 'error')
        }
      },
    }

    async function open() {
      // A dialog made a moment ago holds only its greeting, so the socket can connect right away.
      // Any other entry (reload, browser "back", a resumed dialog) may have earlier messages that
      // the socket does not replay: read them first.
      const fresh = claimFreshStart(dialogId)
      let history: DialogMessageView[] = []
      if (!fresh) {
        const result = await client.getDialog(dialogId).catch(() => null)
        if (cancelled) return
        if (result?.ok) {
          // The conversation is over: its record is in the journal.
          if (result.data.endedAt) {
            router.replace(`/diary/journal/${encodeURIComponent(dialogId)}`)
            return
          }
          history = result.data.messages.map(({ id, role, text }) => ({ id, role, text }))
          if (result.data.memoryMode) setMemoryMode(result.data.memoryMode)
        } else if (result && result.code === DialogApiErrorCode.DIALOG_NOT_FOUND) {
          setMissing(true)
          return
        }
        // Any other failure: connect anyway, the socket has its own retries and failure text.
      }

      // The greeting from the dialog start: the socket may take a moment to open, and the screen
      // must not be empty. Real history already contains it, so it is not added a second time.
      const greeting = history.length > 0 ? null : (fresh ?? readDialogStart(dialogId))?.greeting
      opened = client.createDialogSocket(dialogId, handlers, greeting)
      socket.current = opened
      if (history.length > 0) opened.setHistory(history)
      opened.connect()
      // The first message from home: shown at once as pending, sent as soon as the socket is ready.
      // The agent's greeting is already in the list, so it stays first.
      if (draft.current) opened.sendMessage(draft.current)
    }
    void open()

    return () => {
      cancelled = true
      clearTimeout(endTimer.current)
      opened?.close()
      socket.current = null
      stopWatching.current?.()
      stopWatching.current = null
      const active = capture.current
      capture.current = null
      void active?.stop()
      player.current = null
      replyVoice.dispose()
      voice.current = null
      void voicePlayer.dispose()
    }
  }, [client, dialogId, router, finish, stopRecording])

  const connected = state === 'ready' || state === 'streaming'

  // The microphone or "Поговорить" was pressed on home: the greeting is said aloud, and listening starts as
  // soon as the line is up and the greeting is said. The agent voices it itself; if it does not, the screen's
  // own voice reads the text. The microphone waits either way: an open microphone would hear the greeting as
  // the person's words.
  useEffect(() => {
    if (!connected || !listenOnReady.current) return
    listenOnReady.current = false
    void (async () => {
      const { greeting: text, startListening: listen, openMic: open } = latest.current
      if (text) await voice.current?.greet(text, () => player.current?.drained() ?? Promise.resolve())
      if (viewRef.current !== 'voice' || finished.current) return
      if (handsFree) await open(true)
      else await listen(true)
    })()
  }, [connected, handsFree])

  // A reply that never starts (a silent recording, an agent that dropped the turn) would leave the
  // sphere thinking for good.
  useEffect(() => {
    if (!awaitingReply) return
    const timer = setTimeout(() => setAwaitingReply(false), replyWait.current)
    return () => clearTimeout(timer)
  }, [awaitingReply])

  useEffect(() => {
    busy.current = awaitingReply || state === 'streaming'
  }, [awaitingReply, state])

  // Hands-free never listens in the background: a hidden tab closes the microphone (what was being said
  // is still answered), and only a tap brings it back, which iOS requires anyway.
  useEffect(() => {
    if (!handsFree) return
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void pauseMic('background')
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [handsFree, pauseMic])

  // The player's queue is not React state, so the screen asks it a few times a second.
  useEffect(() => {
    if (view !== 'voice') return
    const timer = setInterval(
      () => setVoiceOut(Boolean(player.current?.speaking || voice.current?.speaking)),
      200,
    )
    return () => clearInterval(timer)
  }, [view])

  /** Whose voice moves the sphere: the person's while listening, the agent's (recorded or ours) otherwise. */
  const level = useCallback(
    () =>
      (recordingRef.current ? capture.current?.level() : undefined) ??
      Math.max(player.current?.level() ?? 0, voice.current?.level() ?? 0),
    [],
  )

  function send(text: string) {
    track(AnalyticsEvent.DialogMessageSent, { input: 'text', size: sizeClass(text.length) })
    follow()
    socket.current?.sendMessage(text)
    setAwaitingReply(true)
    // Typing is quiet: nothing here wakes the player, so the agent's speech stays out of the text.
  }

  /**
   * `automatic`: nobody pressed the microphone just now (home asked for it on opening). A voice screen
   * without a microphone is useless, so instead of a dialog on arrival it says so softly and moves to
   * the text it falls back to.
   */
  async function startListening(automatic: boolean) {
    if (micStarting.current || capture.current) return
    unlockSpeech()
    const refuse = (text: string) => {
      if (automatic) {
        setView('text')
        notify(text, 'info')
      } else {
        setAlert({ title: 'Голос', text, leaves: false })
      }
    }
    if (!isCaptureSupported()) {
      trackVoiceProblem('unsupported')
      refuse(MIC_UNSUPPORTED_TEXT)
      return
    }
    micStarting.current = true
    try {
      // Talking over the agent cuts it off. The player is unlocked here, by the person's own tap
      // (an iOS requirement), which also means a person who only types never hears anything.
      player.current?.stop()
      voice.current?.cancel()
      socket.current?.interruptSpeech()
      await player.current?.unlock().catch(() => trackVoiceProblem('playback_failed'))
      // The worklet is a file of this app (public/), so under a URL prefix it is served from there.
      const started = await startCapture((frame) => socket.current?.sendAudio(frame), {
        workletUrl: appPath('/voice-worklet.js'),
      })
      // The person may have left, the conversation ended, the connection dropped or the text been
      // chosen while the permission prompt was open.
      const live = socket.current
      if (!live || finished.current || !live.isConnected() || viewRef.current !== 'voice') {
        await started.stop()
        return
      }
      capture.current = started
      live.startAudio(started.sampleRate)
      markRecording(true)
      setAwaitingReply(false)
    } catch (error) {
      trackVoiceProblem(micProblemReason(error, isCaptureSupported()))
      refuse(error instanceof MicrophoneDeniedError ? MIC_DENIED_TEXT : MIC_FAILED_TEXT)
    } finally {
      micStarting.current = false
    }
  }

  /** The person finished a turn: the utterance goes to the agent, which should now answer. */
  async function finishUtterance() {
    const active = capture.current
    if (!active) return
    capture.current = null
    markRecording(false)
    socket.current?.endAudio()
    replyWait.current = REPLY_WAIT_MS
    setAwaitingReply(true)
    await active.stop()
  }

  /**
   * Hands-free: the microphone opens for the whole voice session and the detector takes the turns.
   * `automatic` as in `startListening`. A tap while the agent speaks means the person wants the floor,
   * so it silences the agent.
   */
  async function openMic(automatic: boolean) {
    if (micStarting.current || capture.current) return
    unlockSpeech()
    const refuse = (text: string) => {
      if (automatic) {
        setView('text')
        notify(text, 'info')
      } else {
        setAlert({ title: 'Голос', text, leaves: false })
      }
    }
    micStarting.current = true
    try {
      if (!automatic) hush()
      await player.current?.unlock().catch(() => trackVoiceProblem('playback_failed'))
      const started = await startCapture((frame) => socket.current?.sendAudio(frame), {
        workletUrl: appPath('/voice-worklet.js'),
        gated: true,
      })
      const live = socket.current
      if (!live || finished.current || !live.isConnected() || viewRef.current !== 'voice') {
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
        onEvent: (event) => latest.current.onTurn(event),
      })
      setMicOpen(true)
      setPaused(null)
    } catch (error) {
      trackVoiceProblem(micProblemReason(error, isCaptureSupported()))
      refuse(error instanceof MicrophoneDeniedError ? MIC_DENIED_TEXT : MIC_FAILED_TEXT)
    } finally {
      micStarting.current = false
    }
  }

  /** A turn found by the detector: it is sent while the person speaks, and a turn over the agent silences it. */
  function onTurn(event: TurnEvent) {
    const active = capture.current
    if (!active) return
    if (event.type === 'idle') {
      void pauseMic('idle')
      return
    }
    if (event.type === 'start') {
      const live = socket.current
      if (!live?.isConnected()) {
        detector.current.reset(performance.now())
        return
      }
      if (event.bargeIn) hush()
      live.startAudio(active.sampleRate)
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
  }

  /** A tap on the sphere or the microphone: hands-free it pauses and resumes, otherwise it starts and ends a turn. */
  function toggleListening() {
    if (handsFree) {
      if (micOpen) void pauseMic('manual')
      else void openMic(false)
      return
    }
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
    track(AnalyticsEvent.DialogVoiceToggled, { enabled: false })
    hush()
    if (handsFree) await pauseMic('manual')
    else await finishUtterance()
    viewRef.current = 'text'
    setView('text')
  }

  function showVoice() {
    track(AnalyticsEvent.DialogVoiceToggled, { enabled: true })
    viewRef.current = 'voice'
    setView('voice')
    // Choosing the voice is asking to speak: no second tap.
    if (handsFree) void openMic(false)
    else void startListening(false)
  }

  function openEnd() {
    track(AnalyticsEvent.DialogEndSheetOpened)
    // The conversation is being ended: no utterance is wanted, and no answer to it.
    hush()
    void stopRecording()
    setEndError('')
    setEndOpen(true)
    client
      .getDialogSettings()
      .then((settings) => setRecapEnabled(settings.recapEnabled))
      .catch(() => setRecapEnabled(null))
  }

  async function changeRecapEnabled(next: boolean) {
    setRecapEnabled(next)
    try {
      setRecapEnabled((await client.putDialogSettings(next)).recapEnabled)
    } catch {
      setRecapEnabled(!next)
    }
  }

  /** «Предзаполнить»: a draft from the model; the person edits it and saves. */
  async function draftRecap(): Promise<{ recap: string } | { error: string }> {
    try {
      const result = await client.draftDialogRecap(dialogId)
      return result.ok ? { recap: result.data.recap } : { error: RECAP_ERROR_TEXT[result.code] ?? RECAP_ERROR_TEXT.RECAP_UNAVAILABLE }
    } catch (error) {
      return { error: apiErrorText(error, {}, RECAP_ERROR_TEXT.RECAP_UNAVAILABLE) }
    }
  }

  async function submitEnd(takeaway: string | null, tensionAfter: number | null, recapSource: EndRecapSource) {
    // Whether there is a takeaway and whether the scale was answered, never what either says;
    // "skipped" is the sheet closed with nothing filled in.
    track(AnalyticsEvent.DialogEndSubmitted, {
      has_takeaway: takeaway !== null,
      gave_tension: tensionAfter !== null,
      skipped: takeaway === null && tensionAfter === null,
    })
    setEnding(true)
    setEndError('')
    const live = socket.current
    const liveState = live?.getState()
    if (live && (liveState === 'ready' || liveState === 'streaming')) {
      live.end(takeaway, tensionAfter, recapSource)
      // The summary arrives as an `ended` frame; if the agent stays silent, end on our side.
      endTimer.current = setTimeout(() => finish(null), END_FALLBACK_MS)
      return
    }
    // The socket is down (reconnecting, failed): the REST route closes the conversation for real.
    try {
      const result = await client.endDialog(dialogId, {
        ...(takeaway ? { takeaway } : {}),
        ...(tensionAfter !== null ? { tensionAfter } : {}),
        ...(takeaway && recapSource === 'draft' ? { recapSource } : {}),
      })
      if (result.ok) {
        finish(result.data.summary)
      } else {
        setEnding(false)
        setEndError(END_FAILED_TEXT)
      }
    } catch (error) {
      setEnding(false)
      setEndError(apiErrorText(error, {}, END_FAILED_TEXT))
    }
  }

  function leave() {
    // Opened from home in this page load: the previous history entry is home. Otherwise (reload,
    // a link) there is nothing to step back to inside the app.
    if (readDialogStart(dialogId)) router.back()
    else router.replace('/home')
  }

  if (missing) {
    return (
      <>
        <AppHeader title="Разговор" titleIsHeading={false} />
        <div className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center gap-4 px-4 pt-6 pb-24 text-center">
          <h1 className="text-2xl leading-tight font-bold tracking-display-tight text-balance text-foreground">
            Разговор не найден
          </h1>
          <p className="text-base leading-[1.55] text-dim">
            Возможно, ссылка устарела. Начни новый разговор с главной.
          </p>
          <Button asChild className={cn(BUTTON, 'bg-clip-border px-6 focus-visible:border-transparent')}>
            <Link href="/home">На главную</Link>
          </Button>
        </div>
      </>
    )
  }

  const statusText = STATE_TEXT[state]
  const lastReply = messages.findLast((message) => message.role === 'assistant')

  let orb: OrbState
  if (state === 'connecting' || state === 'reconnecting' || state === 'failed') orb = 'connecting'
  else if (recording) orb = 'listening'
  else if (voiceOut || (state === 'streaming' && lastReply?.text)) orb = 'speaking'
  else if (state === 'streaming' || awaitingReply) orb = 'thinking'
  else orb = 'idle'

  // Under the sphere: the person's words as soon as they are recognized, otherwise the agent's latest
  // reply (the greeting stays until the person speaks). While the agent thinks the old reply would be
  // stale, so there is nothing. The whole feed is on the text face.
  const caption = orb === 'thinking' ? '' : recording && hearing ? hearing : (lastReply?.text ?? '')
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

  const sinceDays =
    start?.sinceLastDialogHours != null && start.sinceLastDialogHours >= 24
      ? Math.round(start.sinceLastDialogHours / 24)
      : null

  return (
    <>
      <AppHeader
        // Breakable anywhere: with a large text size a whole word can be wider than the room left, and clipped is worse than wrapped.
        title={<span className="wrap-anywhere">Разговор</span>}
        actions={
          <>
            {/* Sharing needs something said: the link shows the stored messages, and the greeting is not one of them. */}
            {messages.some((message) => message.role === 'user') && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={cn(BUTTON, 'w-11 shrink-0 border-input! px-0 outline-none tab:w-auto tab:px-4')}
                onClick={() => setSharing(true)}
                data-testid="dialog-share"
              >
                <Share2 aria-hidden="true" className="size-5 tab:size-4" />
                <span className="sr-only tab:not-sr-only">Поделиться</span>
              </Button>
            )}
            {view === 'text' ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                // The glass in `outline` redraws the border as the faint hairline; a control keeps its 3:1 edge.
                className={cn(BUTTON, 'w-11 shrink-0 border-input! px-0 outline-none tab:w-auto tab:px-5')}
                disabled={state === 'ended' || ending}
                onClick={openEnd}
                data-testid="dialog-end"
              >
                {/* The bar also holds the menu, the title and SOS: on a phone the word would squeeze the page's only h1 until it is clipped, so the button is just an icon there (its name stays whole). */}
                <CircleCheck aria-hidden="true" className="size-5 tab:hidden" />
                <span className="sr-only tab:not-sr-only">Завершить разговор</span>
              </Button>
            ) : null}
          </>
        }
      />
      <ShareDialogModal dialogId={dialogId} open={sharing} onClose={() => setSharing(false)} />

      {memoryMode === DialogMemoryMode.Off && (
        <div className={cn(COLUMN, 'pt-3')}>
          <p
            className="flex items-start justify-center gap-2 rounded-lg border border-brand-line bg-brand-soft px-4 py-2 text-sm leading-snug text-dim"
            role="note"
            data-testid="dialog-incognito"
          >
            <EyeOff aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-brand-400" />
            <span>
              <b className="font-semibold text-foreground">Без памяти.</b> Этот разговор я не запомню, а сам
              он удалится через сутки
            </span>
          </p>
        </div>
      )}

      {sinceDays !== null && view === 'voice' && (
        <p
          className={cn(COLUMN, 'pt-4 text-center text-sm leading-snug text-dim')}
          data-testid="dialog-since"
        >
          Нас не было {sinceDays}&nbsp;дн. Расскажи, что изменилось.
        </p>
      )}

      {view === 'voice' ? (
        <DialogVoice
          orb={orb}
          level={level}
          caption={caption}
          hint={hint}
          recording={recording}
          micOpen={handsFree ? micOpen : null}
          micDisabled={!connected && !recording && !micOpen}
          endDisabled={state === 'ended' || ending}
          onToggle={toggleListening}
          onText={() => void showText()}
          onEnd={openEnd}
        />
      ) : (
        <>
          <div className={cn(COLUMN, 'flex flex-1 flex-col gap-4 py-6 tab:py-10')}>
            {sinceDays !== null && (
              <p className="text-center text-sm leading-snug text-dim" data-testid="dialog-since">
                Нас не было {sinceDays}&nbsp;дн. Расскажи, что изменилось.
              </p>
            )}

            {messages.length === 0 && state === 'connecting' && (
              <div className="my-8 flex justify-center" aria-hidden="true">
                <Breathing label="вдох · выдох" />
              </div>
            )}

            <DialogFeed messages={messages} />
          </div>

          {/* The dock: the feed scrolls under a fade into the page color, so the last line never meets a hard edge. */}
          <div
            ref={dock}
            className="sticky bottom-0 z-20 bg-linear-to-t from-paper from-65% to-transparent pt-8 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] tab:pb-4 short:pt-4"
          >
            <div className={cn(COLUMN, 'relative')}>
              {hasNew && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={jumpToEnd}
                  data-testid="dialog-jump"
                  className={cn(
                    BUTTON,
                    'absolute bottom-[calc(100%_+_8px)] left-1/2 -translate-x-1/2 gap-1.5 border-input bg-clip-border px-4 text-sm shadow-float hover:bg-secondary hover:brightness-112 focus-visible:border-input',
                  )}
                >
                  <ArrowDown aria-hidden="true" />
                  Новые сообщения
                </Button>
              )}
              {/* Always present: a region inserted together with its text is often not announced. Dim, not faint: it is the only explanation when the conversation stops answering. */}
              <div
                className="text-center text-sm leading-snug text-dim not-empty:pb-2"
                role="status"
                data-testid="dialog-status"
              >
                {statusText}
              </div>
              <ChatComposer
                variant="dock"
                testIdPrefix="dialog"
                placeholder="Напиши, что происходит"
                ready={connected}
                autoFocus
                onSubmit={send}
                onMic={showVoice}
              />
              <p className="mt-2 hidden text-center text-xs leading-snug text-faint md:block short:hidden">
                «Рядом»&nbsp;— самоподдержка, не психотерапия. В опасной ситуации звони&nbsp;112.
              </p>
            </div>
          </div>
        </>
      )}

      <DialogEndSheet
        open={endOpen}
        onClose={() => setEndOpen(false)}
        onSubmit={(takeaway, tension, source) => void submitEnd(takeaway, tension, source)}
        busy={ending}
        error={endError}
        recapEnabled={recapEnabled}
        onRecapEnabledChange={(next) => void changeRecapEnabled(next)}
        onDraft={draftRecap}
      />
      <DialogAlert
        open={alert !== null}
        title={alert?.title ?? ''}
        text={alert?.text ?? ''}
        // A finished conversation is the moment an address has something to give: this one is kept.
        offer={
          alert?.leaves && (user?.email === null || user?.isEmailConfirmed === false)
            ? {
                text: `Без почты разговоры хранятся ${ANONYMOUS_RETENTION_DAYS} дней после последнего визита, и войти с другого телефона нельзя. Привяжи почту, чтобы не потерять их.`,
                action: user?.email === null ? 'Привязать почту' : 'Подтвердить почту',
                onAction: () => {
                  setAlert(null)
                  router.push('/profile?linkEmail=1')
                },
              }
            : undefined
        }
        onClose={() => {
          const leaves = alert?.leaves ?? false
          setAlert(null)
          if (leaves) leave()
        }}
      />
    </>
  )
}
