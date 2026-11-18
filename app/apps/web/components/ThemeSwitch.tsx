'use client'

import { Moon, Sun } from 'lucide-react'
import { useRef, type PointerEvent } from 'react'
import { cn } from '@ryadom/ui/lib/utils'
import { FOCUS_RING } from './controls'
import { chooseTheme, useTheme } from '@/lib/theme'

// A horizontal drag past this many pixels is a swipe, not a tap.
const SWIPE_MIN_PX = 24

/**
 * The compact day/night switch of the home and the first screen, in the top bar before SOS. Tap,
 * horizontal swipe and keyboard all flip the theme; the choice is stored on this device and wins
 * over the schedule until the next manual change. It touches nothing else — no draft, route or
 * request. The visual pill is small; the hit area is the full 44×44 button. The thumb shows the
 * theme in effect — a sun by day, a glowing moon at night — so the state reads at a glance.
 */
export default function ThemeSwitch({ className }: { className?: string }) {
  const theme = useTheme()
  const pressX = useRef<number | null>(null)
  // A swipe ends in a click: without this flag the flip would happen twice.
  const swiped = useRef(false)

  function flip() {
    chooseTheme(theme === 'light' ? 'dark' : 'light')
  }

  function onPointerDown(event: PointerEvent) {
    pressX.current = event.clientX
  }

  function onPointerUp(event: PointerEvent) {
    if (pressX.current === null) return
    const dx = event.clientX - pressX.current
    pressX.current = null
    if (Math.abs(dx) < SWIPE_MIN_PX) return
    swiped.current = true
    // The pill reads day on the left, night on the right: a swipe asks for the side it points to.
    const next = dx > 0 ? 'dark' : 'light'
    if (next !== theme) chooseTheme(next)
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={theme === 'dark'}
      // The name is the action the next press performs, not the current state.
      aria-label={theme === 'light' ? 'Включить тёмную тему' : 'Включить светлую тему'}
      onClick={() => {
        if (swiped.current) {
          swiped.current = false
          return
        }
        flip()
      }}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      data-testid="theme-switch"
      className={cn(
        FOCUS_RING,
        // touch-pan-y: a vertical scroll must still scroll when it starts on the switch.
        'flex size-11 shrink-0 cursor-pointer touch-pan-y items-center justify-center rounded-full text-dim outline-none hover:text-foreground',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="flex h-5 w-9 items-center rounded-full border border-input bg-accent px-0.5"
      >
        <span
          className={cn(
            'grid size-4 place-items-center rounded-full transition-[transform,background-color,color,box-shadow] motion-reduce:transition-none',
            // The moon glows so the night side reads on the dark track; the sun needs no glow by day.
            theme === 'dark'
              ? 'translate-x-4 bg-slate-700 text-sky-200 shadow-[0_0_8px_2px_rgba(186,230,253,0.55)]'
              : 'bg-amber-300 text-amber-900',
          )}
        >
          {/*
            Exactly one icon, the one of the current theme: a sliding thumb must never carry
            the sun and the moon at once.
           */}
          {theme === 'dark' ? <Moon size={10} strokeWidth={2.5} /> : <Sun size={10} strokeWidth={2.5} />}
        </span>
      </span>
    </button>
  )
}
