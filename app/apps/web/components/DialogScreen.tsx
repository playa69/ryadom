'use client'

import { ArrowDown, CircleCheck } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DialogApiErrorCode,
  DialogWsErrorCode,
  type DialogSummaryApiResponse,
} from '@ryadom/contracts/api/dialogs'
import { apiErrorText } from '@ryadom/client-core/errors'
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
import { VoicePlayer } from '@ryadom/client-core/voice/player'
import { ReplyVoice, unlockSpeech } from '@ryadom/client-core/voice/speech'
import { Button } from '@ryadom/ui/components/button'
import type { OrbState } from '@ryadom/ui/components/voice-orb'
import { cn } from '@ryadom/ui/lib/utils'
import { useClient } from '@/lib/auth'
import { AppHeader } from './AppHeader'
import Breathing from './Breathing'
import ChatComposer from './ChatComposer'
import DialogAlert from './DialogAlert'
import DialogEndSheet from './DialogEndSheet'
import DialogFeed from './DialogFeed'
import DialogVoice from './DialogVoice'
import { BUTTON, COLUMN } from './controls'
import { useNotice, useNoticePlacement } from './Notice'
import { useSos } from './Sos'
import { claimFreshStart, readDialogStart, takeDialogHandoff } from './dialog-start'
import { initialDialogView, rememberDialogView, type DialogView } from './dialog-view'
import { useStickToEnd } from './dialog-scroll'

/**
 * The conversation. Voice is the main way to talk: the screen opens on
 * the sphere, which the person taps to speak and taps again to finish. The text face is one tap away
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

/** Without a first word from the agent the sphere must not think forever. */
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
  const router = useRouter()
  const notify = useNotice()
  // The input box sits where the default toast stack would, so toasts go under the header.
  useNoticePlacement('top')
  const { openSos } = useSos()

  const start = readDialogStart(dialogId)
  const [messages, setMessages] = useState<DialogMessageView[]>(() => greetingMessages(start?.greeting))
  const [state, setState] = useState<DialogSocketState>('connecting')
  const [view, setView] = useState<DialogView>(() => initialDialogView(dialogId))
  const [recording, setRecording] = useState(false)
  /** What the recognition has heard so far in the current turn. */
  const [hearing, setHearing] = useState('')
  /** The person has finished speaking or typing and the agent has not started to answer yet. */
  const [awaitingReply, setAwaitingReply] = useState(false)
  /** The agent's voice is audible: the text can already be complete while the audio still plays. */
  const [voiceOut, setVoiceOut] = useState(false)
  const [endOpen, setEndOpen] = useState(false)
  const [ending, setEnding] = useState(false)
  const [endError, setEndError] = useState('')
  const [alert, setAlert] = useState<AlertState | null>(null)
  const [missing, setMissing] = useState(false)

  const socket = useRef<DialogSocket | null>(null)
  const capture = useRef<VoiceCapture | null>(null)
  const player = useRef<VoicePlayer | null>(null)
  /** The sphere's own voice for what the agent does not speak itself: the greeting, a reply without speech. */
  const voice = useRef<ReplyVoice | null>(null)
  const micStarting = useRef(false)
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

  const stopRecording = useCallback(async () => {
    const active = capture.current
    capture.current = null
    setRecording(false)
    setHearing('')
    if (active) await active.stop()
  }, [])

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
      setAlert({
        title: 'Спасибо, что поговорил(а)',
        text: summary?.title
          ? `Забираешь с собой: ${summary.title}`
          : 'Разговор завершён. Я рядом, когда понадоблюсь.',
        leaves: true,
      })
    },
    [stopRecording],
  )

  // The socket handlers outlive renders; they read the latest helpers through here.
  const greeting = start?.greeting ?? null
  const latest = useRef({ notify, openSos, startListening, greeting })
  useEffect(() => {
    latest.current = { notify, openSos, startListening, greeting }
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
      // Someone who is reading is not spoken to: the frames of this speech are dropped.
      if (viewRef.current === 'voice') voicePlayer.begin()
      replyVoice.agentSpoke(messageId)
    }

    // Taken once, here: a browser "back" to this dialog later must not send the text again.
    const handoff = takeDialogHandoff(dialogId)
    if (handoff?.draft) draft.current = handoff.draft
    if (handoff?.listen) {
      listenOnReady.current = true
      // The agent's greeting is about to arrive as audio. The tap that led here still counts as the person's
      // gesture, and the player must be awake before the frames.
      void voicePlayer.unlock().catch(() => undefined)
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
      onMessages: (list) => {
        // A reply is read out only to someone who is on the voice and not talking themselves.
        replyVoice.observe(list, viewRef.current === 'voice' && !capture.current)
        setMessages(list)
      },
      onSpeech: (messageId, phase) =>
        phase === 'start' ? startAgentSpeech(messageId) : replyVoice.agentSpeechEnded(messageId),
      onTranscript: (text, final) => setHearing(final ? '' : text),
      onAudio: (frame) => voicePlayer.enqueue(frame),
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
            router.replace(`/journal/${encodeURIComponent(dialogId)}`)
            return
          }
          history = result.data.messages.map(({ id, role, text }) => ({ id, role, text }))
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
      const { greeting: text, startListening: listen } = latest.current
      if (text) await voice.current?.greet(text, () => player.current?.drained() ?? Promise.resolve())
      if (viewRef.current === 'voice' && !finished.current) await listen(true)
    })()
  }, [connected])

  // A reply that never starts (a silent recording, an agent that dropped the turn) would leave the
  // sphere thinking for good.
  useEffect(() => {
    if (!awaitingReply) return
    const timer = setTimeout(() => setAwaitingReply(false), REPLY_WAIT_MS)
    return () => clearTimeout(timer)
  }, [awaitingReply])

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
    () => capture.current?.level() ?? Math.max(player.current?.level() ?? 0, voice.current?.level() ?? 0),
    [],
  )

  function send(text: string) {
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
      await player.current?.unlock().catch(() => undefined)
      const started = await startCapture((frame) => socket.current?.sendAudio(frame))
      // The person may have left, the conversation ended, the connection dropped or the text been
      // chosen while the permission prompt was open.
      const live = socket.current
      if (!live || finished.current || !live.isConnected() || viewRef.current !== 'voice') {
        await started.stop()
        return
      }
      capture.current = started
      live.startAudio(started.sampleRate)
      setRecording(true)
      setAwaitingReply(false)
    } catch (error) {
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
    setRecording(false)
    setHearing('')
    socket.current?.endAudio()
    setAwaitingReply(true)
    await active.stop()
  }

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
    viewRef.current = 'text'
    setView('text')
  }

  function showVoice() {
    viewRef.current = 'voice'
    setView('voice')
    // Choosing the voice is asking to speak: no second tap.
    void startListening(false)
  }

  function openEnd() {
    // The conversation is being ended: no utterance is wanted, and no answer to it.
    hush()
    void stopRecording()
    setEndError('')
    setEndOpen(true)
  }

  async function submitEnd(takeaway: string | null, tensionAfter: number | null) {
    setEnding(true)
    setEndError('')
    const live = socket.current
    const liveState = live?.getState()
    if (live && (liveState === 'ready' || liveState === 'streaming')) {
      live.end(takeaway, tensionAfter)
      // The summary arrives as an `ended` frame; if the agent stays silent, end on our side.
      endTimer.current = setTimeout(() => finish(null), END_FALLBACK_MS)
      return
    }
    // The socket is down (reconnecting, failed): the REST route closes the conversation for real.
    try {
      const result = await client.endDialog(dialogId, {
        ...(takeaway ? { takeaway } : {}),
        ...(tensionAfter !== null ? { tensionAfter } : {}),
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
  const hint =
    statusText ??
    {
      connecting: '',
      idle: 'Нажми на шар и говори',
      listening: 'Слушаю. Нажми, когда закончишь',
      thinking: 'Думаю…',
      speaking: 'Нажми, чтобы перебить',
    }[orb]

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
          view === 'text' ? (
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
          ) : undefined
        }
      />

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
          micDisabled={!connected && !recording}
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
        onSubmit={(takeaway, tension) => void submitEnd(takeaway, tension)}
        busy={ending}
        error={endError}
      />
      <DialogAlert
        open={alert !== null}
        title={alert?.title ?? ''}
        text={alert?.text ?? ''}
        onClose={() => {
          const leaves = alert?.leaves ?? false
          setAlert(null)
          if (leaves) leave()
        }}
      />
    </>
  )
}
