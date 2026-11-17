'use client'

import { Keyboard, Mic } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@ryadom/ui/components/button'
import { VoiceOrb, type OrbState } from '@ryadom/ui/components/voice-orb'
import { cn } from '@ryadom/ui/lib/utils'
import { PRIMARY_BUTTON } from '@/app/(auth)/_components/parts'
import { BASE_PATH } from '@/lib/base-path'
import { BUTTON } from './controls'

/** What the sphere says to someone it meets for the first time: an invitation, not a form. */
const HELLO_LINES = ['Привет! Я рядом.', 'Поговорим?']

/** The greeting recorded in the agent's voice (`public/`); SaluteSpeech voice "Вера" (the one voice of the Sber path), 24 kHz. */
const GREETING_SRC = `${BASE_PATH}/hello-greeting.wav`

/** How long the sphere moves as if speaking the greeting before it settles to breathing. */
const SPEAKING_MS = 3200

/**
 * The newcomer's first screen: the sphere of the voice screen greets the person and invites them to talk,
 * before any form. Nothing is sent and no account is made here: the consent is asked in a window after the
 * press ("Поговорить" or the keyboard), and only then the conversation starts. The greeting is spoken
 * aloud as soon as the browser allows (a page may make sound only after a gesture: until then the sphere
 * moves as if speaking, and the first press anywhere plays the phrase). It stops when the screen goes away.
 *
 * The plaque at the foot says what the service is and what it costs, because a person sent here by an ad
 * has seen nothing else of it, and the ad's moderation checks that its promises are on the page.
 */
export default function FirstHello({
  onVoice,
  onText,
  busy = false,
  error = '',
}: {
  onVoice(): void
  onText(): void
  busy?: boolean
  error?: string
}) {
  const [orb, setOrb] = useState<OrbState>('speaking')
  const started = useRef(0)
  useEffect(() => {
    started.current = performance.now()
    const timer = window.setTimeout(() => setOrb('idle'), SPEAKING_MS)
    // The greeting is spoken aloud once. A browser may refuse sound before a gesture, so it is tried at once
    // and, if refused, on the first touch anywhere on the screen; a failure leaves the silent sphere as is.
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
  // A voice-like swell while "speaking": syllables over a slower phrase, no sound behind it.
  const level = () => {
    if (orb !== 'speaking') return 0
    const t = (performance.now() - started.current) / 1000
    return Math.max(0, 0.22 + 0.16 * Math.sin(t * 9) * Math.sin(t * 1.7))
  }

  return (
    <div
      className="flex min-h-[calc(100dvh-3.5rem-1px-env(safe-area-inset-top,0px))] flex-col items-center gap-4 px-[max(1rem,env(safe-area-inset-left,0px))] pt-4 text-center"
      data-testid="first-hello"
    >
      {/* The whole stage is the target, as on the voice screen: the sphere is large and need not be aimed at. */}
      <div
        role="presentation"
        className="flex min-h-0 w-full flex-1 cursor-pointer items-center justify-center"
        onClick={() => {
          if (!busy) onVoice()
        }}
      >
        <VoiceOrb state={orb} level={level} className="w-[min(80vw,40dvh,360px)]" />
      </div>

      {/* The page's one heading. One sentence per line, so "Я рядом" never splits. */}
      <h1 className="text-2xl leading-snug font-semibold text-foreground" data-testid="hello-caption">
        {HELLO_LINES.map((line) => (
          <span key={line} className="block">
            {line}
          </span>
        ))}
      </h1>

      <div className="flex w-full max-w-md items-stretch gap-2 pt-2">
        <Button
          type="button"
          className={cn(PRIMARY_BUTTON, 'min-w-0 flex-1')}
          aria-busy={busy || undefined}
          disabled={busy}
          onClick={onVoice}
          data-testid="hello-voice"
        >
          <Mic aria-hidden="true" className="size-5" />
          Поговорить
        </Button>
        <Button
          type="button"
          variant="outline"
          aria-label="Написать текстом"
          title="Написать текстом"
          disabled={busy}
          onClick={onText}
          data-testid="hello-text"
          className={cn(BUTTON, 'h-auto min-h-13 w-13 shrink-0 border-input! p-0')}
        >
          <Keyboard aria-hidden="true" className="size-5" />
        </Button>
      </div>
      {error && (
        <p className="max-w-[40ch] text-base leading-snug text-danger" role="alert" data-testid="form-error">
          {error}
        </p>
      )}

      {/* What the service is, at the foot and in plain sight: the greeting above is all invitation. */}
      <div
        className="mb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] w-full max-w-md rounded-2xl border border-line bg-white/[0.03] px-4 py-3 text-sm leading-snug text-balance text-dim"
        data-testid="hello-plaque"
      >
        <p>
          «Рядом»&nbsp;— бесплатный ИИ-собеседник, без регистрации. Самоподдержка, а&nbsp;не психотерапия
          и&nbsp;не медицинская помощь.
        </p>
        <p className="mt-1 text-xs">В опасной ситуации звони 112.</p>
      </div>
    </div>
  )
}
