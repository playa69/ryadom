'use client'

import { ChevronDown, Mic } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AudioDeviceKind, AudioDeviceOption } from '@ryadom/client-core/voice/devices'
import { AUDIO_DEVICE_TEXT, type AudioRoutingView } from '@ryadom/client-core/voice/routing'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@ryadom/ui/components/dropdown-menu'
import { cn } from '@ryadom/ui/lib/utils'
import { FOCUS_RING } from './controls'

/**
 * Which microphone hears the person and where the companion's voice goes, under the voice controls. It
 * is there only when there is something to choose: one microphone and a speaker the page cannot choose
 * leave the screen as it was.
 *
 * The chip names the microphone in use, because that is what goes wrong unseen: a person talks into a
 * headset while the page listens to the laptop, or to an audio interface the browser happened to list
 * first. `attention` lights it when the person seems not to be heard. The menu stays open after a choice,
 * so the meter can show that the new microphone hears them.
 */
export default function DialogDevices({
  view,
  level,
  attention,
  onOpen,
  onChoose,
}: {
  view: AudioRoutingView
  /** How loud the open microphone is, 0..1; 0 while it is closed. */
  level: () => number
  attention: boolean
  onOpen(): void
  onChoose(kind: AudioDeviceKind, option: AudioDeviceOption): void
}) {
  const [open, setOpen] = useState(false)
  const { inputs, outputs, input, output } = view
  const chosen = (options: AudioDeviceOption[], id: string) => options.find((option) => option.id === id)

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) onOpen()
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            FOCUS_RING,
            'glass-2 flex max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-full border-input! px-3.5 py-2 text-sm leading-none text-dim outline-none transition-[filter,color] hover:brightness-125 data-[state=open]:text-foreground',
            attention && 'text-foreground ring-2 ring-ring',
          )}
          aria-label={
            input ? `${AUDIO_DEVICE_TEXT.menu}. Слушаю через «${input.label}»` : AUDIO_DEVICE_TEXT.menu
          }
          data-testid="voice-devices"
        >
          <Mic className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{input?.label ?? AUDIO_DEVICE_TEXT.menu}</span>
          <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="center"
        sideOffset={8}
        collisionPadding={16}
        className="w-[min(24rem,calc(100vw-2rem))] p-1.5"
        data-testid="voice-devices-menu"
      >
        <DropdownMenuLabel className="flex items-center justify-between gap-3 text-sm">
          {AUDIO_DEVICE_TEXT.input}
          {open && <MicLevel level={level} />}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={input?.id ?? ''}
          onValueChange={(id) => {
            const option = chosen(inputs, id)
            if (option) onChoose('input', option)
          }}
        >
          {inputs.map((option) => (
            <DeviceItem key={option.id} option={option} />
          ))}
        </DropdownMenuRadioGroup>

        {outputs.length > 1 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-sm">{AUDIO_DEVICE_TEXT.output}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={output?.id ?? ''}
              onValueChange={(id) => {
                const option = chosen(outputs, id)
                if (option) onChoose('output', option)
              }}
            >
              {outputs.map((option) => (
                <DeviceItem key={option.id} option={option} />
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
        <p className="px-1.5 pt-2 pb-1 text-xs leading-snug text-dim">Выбор запомнится в этом браузере</p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function DeviceItem({ option }: { option: AudioDeviceOption }) {
  return (
    <DropdownMenuRadioItem
      value={option.id}
      // Stays open: the meter above shows at once whether the new microphone hears.
      onSelect={(event) => event.preventDefault()}
      className="min-h-10 cursor-pointer py-1.5 text-[0.9375rem]"
      data-testid="voice-device"
    >
      {option.system ? (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span>{AUDIO_DEVICE_TEXT.system}</span>
          <span className="truncate text-xs text-dim">{option.label}</span>
        </span>
      ) : (
        <span className="truncate">{option.label}</span>
      )}
    </DropdownMenuRadioItem>
  )
}

/** A bar that follows the microphone: if it moves when the person speaks, this microphone hears them. */
function MicLevel({ level }: { level: () => number }) {
  const bar = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let frame = 0
    let shown = 0
    const draw = () => {
      // Rises at once and falls slowly, so a word stays visible for a moment.
      shown = Math.max(level(), shown * 0.9)
      if (bar.current) bar.current.style.transform = `scaleX(${shown})`
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [level])

  return (
    <span
      className="relative h-1.5 w-16 overflow-hidden rounded-full bg-foreground/10"
      role="img"
      aria-label="Громкость микрофона"
      data-testid="voice-devices-level"
    >
      <span ref={bar} className="absolute inset-0 origin-left scale-x-0 rounded-full bg-ring" />
    </span>
  )
}
