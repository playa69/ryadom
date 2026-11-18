import { Button, Icon } from 'framework7-react'
import { useEffect, useRef, useState } from 'react'
import VoiceOrb, { type OrbState } from './VoiceOrb'

/** What the sphere says to someone it meets for the first time: an invitation, not a form. */
const HELLO_LINES = ['Привет! Я рядом.', 'Поговорим?']

/** The greeting in the voice of the Sber path («Вера»), the same file the web first screen plays. */
const GREETING_SRC = `${import.meta.env.BASE_URL}hello-greeting.wav`

/** How long the sphere moves as if speaking the greeting before it settles to breathing. */
const SPEAKING_MS = 3200

/**
 * The first screen of a new person in the PWA and Telegram (the web has the same one): the sphere greets
 * and invites them to talk, before any form. Nothing is sent and no account is made here: the consent
 * sheet opens on a press («Поговорить», the sphere or the keyboard), and only then the conversation starts.
 *
 * The greeting is spoken aloud as soon as the browser allows. A page may make sound only after a gesture:
 * until then the sphere moves as if speaking, and the first touch anywhere plays the phrase. The sound
 * stops when the screen goes away.
 */
export default function FirstHello({
  onVoice,
  onText,
  busy,
  error,
}: {
  onVoice: () => void
  onText: () => void
  busy: boolean
  error: string
}) {
  const [orb, setOrb] = useState<OrbState>('speaking')
  const started = useRef(0)
  useEffect(() => {
    started.current = performance.now()
    const timer = window.setTimeout(() => setOrb('idle'), SPEAKING_MS)
    const audio = new Audio(GREETING_SRC)
    let played = false
    const play = () => {
      if (played) return
      audio.play().then(
        () => {
          played = true
          window.clearTimeout(timer)
          started.current = performance.now()
          setOrb('speaking')
        },
        () => {},
      )
    }
    audio.addEventListener('ended', () => setOrb('idle'))
    play()
    window.addEventListener('pointerdown', play)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointerdown', play)
      audio.pause()
    }
  }, [])
  // A voice-like swell while "speaking": syllables over a slower phrase.
  const level = () => {
    if (orb !== 'speaking') return 0
    const t = (performance.now() - started.current) / 1000
    return Math.max(0, 0.22 + 0.16 * Math.sin(t * 9) * Math.sin(t * 1.7))
  }

  return (
    <div className="rd-first-hello" data-testid="first-hello">
      {/* The whole stage is the target, as on the voice screen: the sphere is large and need not be aimed at. */}
      <div
        role="presentation"
        className="rd-first-hello-stage"
        onClick={() => {
          if (!busy) onVoice()
        }}
      >
        <VoiceOrb state={orb} level={level} />
      </div>
      <h1 className="rd-first-hello-caption" data-testid="hello-caption">
        {HELLO_LINES.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </h1>
      <div className="rd-first-hello-actions">
        <Button
          fill
          large
          preloader
          loading={busy}
          disabled={busy}
          onClick={onVoice}
          data-testid="hello-voice"
        >
          <Icon f7="mic_fill" size={20} aria-hidden="true" />
          Поговорить
        </Button>
        <Button
          large
          outline
          disabled={busy}
          onClick={onText}
          aria-label="Написать текстом"
          className="rd-first-hello-text"
          data-testid="hello-text"
        >
          <Icon f7="keyboard" size={20} aria-hidden="true" />
        </Button>
      </div>
      {error && (
        <p className="rd-form-error" role="alert" data-testid="form-error">
          {error}
        </p>
      )}
      {/* What the service is, in plain sight: the greeting above is all invitation. */}
      <div className="rd-first-hello-plaque" data-testid="hello-plaque">
        <p>
          «Рядом»&nbsp;— бесплатный ИИ-собеседник, без регистрации. Самоподдержка, а&nbsp;не психотерапия
          и&nbsp;не медицинская помощь.
        </p>
        <p className="rd-fineprint">В опасной ситуации звони 112.</p>
      </div>
    </div>
  )
}
