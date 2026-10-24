'use client'

import { CircleCheck, Keyboard, Mic, Pause, Square } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { Button } from '@ryadom/ui/components/button'
import { VoiceOrb, type OrbMood, type OrbState } from '@ryadom/ui/components/voice-orb'
import { cn } from '@ryadom/ui/lib/utils'
import { BUTTON, COLUMN, FOCUS_RING } from './controls'

/**
 * The voice face of the conversation: the sphere is the interface. Hands-free a tap pauses the microphone
 * and takes it back; otherwise the person taps it to speak and taps again to finish. Under it are their own
 * words as they are recognized, then the companion's latest reply. The whole feed is on the text face, one
 * tap away.
 */
export default function DialogVoice({
  orb,
  mood,
  level,
  caption,
  hint,
  recording,
  micOpen,
  micDisabled,
  endDisabled,
  onToggle,
  onText,
  onEnd,
}: {
  orb: OrbState
  mood?: OrbMood | null
  level: () => number
  caption: string
  hint: string
  recording: boolean
  /** Hands-free: whether the microphone is listening (the button pauses it) or paused; null when off. */
  micOpen: boolean | null
  micDisabled: boolean
  endDisabled: boolean
  onToggle(): void
  onText(): void
  onEnd(): void
}) {
  const captionBox = useRef<HTMLDivElement>(null)
  const handsFree = micOpen !== null
  let micLabel = recording ? 'Остановить запись' : 'Говорить'
  if (handsFree) micLabel = micOpen ? 'Поставить микрофон на паузу' : 'Включить микрофон'

  // A long reply streams in below the visible lines: keep the newest words in view.
  useEffect(() => {
    const box = captionBox.current
    if (box) box.scrollTop = box.scrollHeight
  }, [caption])

  return (
    <div
      className={cn(
        COLUMN,
        'flex flex-1 flex-col items-center gap-3 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] tab:pb-8 short:gap-1.5 short:pt-2',
      )}
      data-testid="dialog-voice"
    >
      {/* The whole stage is the target: the sphere is large, and the person need not aim. The microphone
          button below is the same action for those who look for a button. */}
      <div
        role="presentation"
        className="flex min-h-0 w-full flex-1 cursor-pointer items-center justify-center"
        onClick={() => {
          if (!micDisabled) onToggle()
        }}
        data-testid="voice-stage"
      >
        <VoiceOrb
          state={orb}
          mood={mood}
          level={level}
          className="w-[min(88vw,46dvh,380px)] short:w-[min(60vw,40dvh,380px)]"
        />
      </div>

      <div
        ref={captionBox}
        className="max-h-[6.75em] w-full max-w-xl overflow-y-auto text-center text-xl leading-normal text-balance text-foreground wrap-anywhere empty:hidden"
        data-testid="voice-caption"
      >
        {caption}
      </div>
      {/* Dim, not faint: the hint is also the only explanation when the conversation stops answering. */}
      <p
        className="min-h-[1.5em] text-center text-sm leading-snug text-dim"
        role="status"
        data-testid="voice-hint"
      >
        {hint}
      </p>

      <div className="flex items-start justify-center gap-7 pt-2">
        <SideButton label="Текстом" accessibleName="Писать текстом" onClick={onText} testId="voice-text">
          <Keyboard className="size-5" aria-hidden="true" />
        </SideButton>
        <Button
          type="button"
          size="icon"
          className={cn(
            BUTTON,
            'size-19 border-transparent bg-clip-border outline-none shadow-(--ryadom-cta-glow) hover:brightness-112 focus-visible:border-transparent',
            // Recording is the one red thing besides SOS: the same pulse the old microphone had.
            recording &&
              "bg-sos bg-none text-white shadow-none hover:bg-sos after:absolute after:-inset-px after:rounded-full after:content-[''] motion-safe:after:animate-rec relative",
          )}
          aria-label={micLabel}
          disabled={micDisabled}
          onClick={onToggle}
          data-testid="dialog-mic"
        >
          {handsFree && micOpen && <Pause className="size-6 fill-current" aria-hidden="true" />}
          {!handsFree && recording && <Square className="size-6 fill-current" aria-hidden="true" />}
          {(handsFree ? !micOpen : !recording) && <Mic className="size-7" aria-hidden="true" />}
        </Button>
        <SideButton
          label="Завершить"
          accessibleName="Завершить разговор"
          onClick={onEnd}
          disabled={endDisabled}
          testId="dialog-end"
        >
          <CircleCheck className="size-5" aria-hidden="true" />
        </SideButton>
      </div>
    </div>
  )
}

/** A round button with its word under it, the width of the big one's shoulder. */
function SideButton({
  label,
  accessibleName,
  onClick,
  disabled,
  testId,
  children,
}: {
  label: string
  accessibleName: string
  onClick(): void
  disabled?: boolean
  testId: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className={cn(
        FOCUS_RING,
        'group mt-3 flex w-20 cursor-pointer flex-col items-center gap-1.5 rounded-lg text-xs text-dim outline-none disabled:cursor-default disabled:opacity-50',
      )}
      aria-label={accessibleName}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
    >
      <span className="glass-2 flex size-13 items-center justify-center rounded-full border-input! text-foreground transition-[filter] group-enabled:group-hover:brightness-125">
        {children}
      </span>
      <span aria-hidden="true">{label}</span>
    </button>
  )
}
