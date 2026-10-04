import * as React from 'react'
import { Badge } from '@ryadom/ui/components/badge'
import { Button } from '@ryadom/ui/components/button'
import { Card, CardContent } from '@ryadom/ui/components/card'
import { cn } from '@ryadom/ui/lib/utils'
import Link from 'next/link'
import { FOCUS_RING, LIT_BUTTON } from './chrome'

/** The site's body text. <body> carries none, so each page root and each part with its own text base sets it. */
export const COPY = 'text-[17px] leading-[1.6] text-pretty min-[1280px]:text-[18px]'

/** A link inside running text: blue, underlined only on hover, as every link on the page was. */
export const IN_TEXT_LINK = cn('rounded-sm text-brand-400 hover:underline', FOCUS_RING)

/**
 * A glass pane over the night sky: the base of the steps, the hotline rows, the callout. The shadow
 * is an arbitrary property because `glass` sets its own box-shadow after `shadow-card` in the
 * stylesheet and would drop the soft contact shadow.
 */
export const PANE = 'glass relative overflow-hidden [box-shadow:var(--ryadom-highlight),var(--ryadom-shadow-1)]'

/*
 * The tint cycles teal, indigo, violet by position among siblings, so a grid reads as a set of lit
 * panes rather than identical boxes; text stays on the dark glass, the glow is only a wash behind it.
 */
const TINT =
  '[--tint:var(--ryadom-teal-rgb)] nth-[3n+2]:[--tint:var(--ryadom-indigo-rgb)] nth-[3n]:[--tint:var(--ryadom-violet-rgb)]'

const GLOWS = {
  teal: '[--glow:var(--ryadom-teal-rgb)]',
  indigo: '[--glow:var(--ryadom-indigo-rgb)]',
  violet: '[--glow:var(--ryadom-violet-rgb)]',
}
const SIDES = { left: '[--glow-x:28%]', right: '[--glow-x:72%]' }

/**
 * One section of the page. A wash of aurora sits behind it, alternating sides: the page background
 * is fixed, so without these a long page would read as one flat field once you scroll past the
 * first screen. The ellipse fades out exactly at the section's own box (its 28% radius reaches the
 * nearer side edge from either centre, 28% or 72%), so no edge shows and nothing overflows. There is no rule between sections: a hairline across the night sky reads as a seam.
 */
export function Section({
  glow,
  side,
  padded = true,
  className,
  ...props
}: React.ComponentProps<'section'> & {
  glow: keyof typeof GLOWS
  side: keyof typeof SIDES
  /** The hero sets its own vertical rhythm. */
  padded?: boolean
}) {
  return (
    <section
      className={cn(
        'relative before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:bg-[radial-gradient(28%_50%_at_var(--glow-x)_50%,rgba(var(--glow),0.2),transparent)]',
        GLOWS[glow],
        SIDES[side],
        padded && 'py-7 min-[400.02px]:py-9 min-[720.02px]:py-18 min-[1280px]:py-26',
        className,
      )}
      {...props}
    />
  )
}

export function H2({ className, ...props }: React.ComponentProps<'h2'>) {
  return (
    <h2
      className={cn(
        'mb-4 text-[length:clamp(28px,5vw,40px)] leading-[1.15] font-[650] tracking-display-tight text-balance min-[1280px]:text-[length:clamp(38px,2.8vw,48px)]',
        className,
      )}
      {...props}
    />
  )
}

export function H3({ className, ...props }: React.ComponentProps<'h3'>) {
  return (
    <h3
      className={cn('mb-2 text-[19px] leading-[1.3] font-[650] tracking-display text-balance min-[1280px]:text-[21px]', className)}
      {...props}
    />
  )
}

export function SectionTitle({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="max-w-[680px] min-[1280px]:max-w-[780px]">
      <H2>{title}</H2>
      {children && <p className="mb-4 text-[18px] text-dim min-[1280px]:text-[21px]">{children}</p>}
    </div>
  )
}

/**
 * Explicit columns, not auto-fit: auto-fit turned six modes into 4 + 2 and three scenes into 2 + 1 with
 * a hole beside the last card. Two columns from a tablet, three from a laptop; when an odd card would be
 * left alone in the two-column layout it takes the whole row.
 */
export function Grid({ cols, className, ...props }: React.ComponentProps<'div'> & { cols: 2 | 3 }) {
  return (
    <div
      className={cn(
        'mt-6 grid gap-[18px] min-[720.02px]:mt-9 min-[720.02px]:grid-cols-2',
        cols === 3 &&
          'min-[1024px]:grid-cols-3 min-[720.02px]:max-[1024px]:[&>:last-child:nth-child(odd)]:col-span-2',
        className,
      )}
      {...props}
    />
  )
}

/** A glass card with a tinted glow in one corner; its content is padded by the card's own spacing. */
export function Tile({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <Card
      className={cn(
        COPY,
        PANE,
        'gap-0 text-foreground [--card-spacing:22px] *:relative min-[720.02px]:[--card-spacing:28px] min-[1280px]:[--card-spacing:32px]',
        TINT,
        'before:pointer-events-none before:absolute before:-top-[35%] before:-right-[25%] before:aspect-square before:w-[70%] before:rounded-full before:bg-[radial-gradient(circle,rgba(var(--tint),0.3),transparent_70%)]',
        className,
      )}
    >
      <CardContent>{children}</CardContent>
    </Card>
  )
}

/** The small blue label above a card's title. */
export function Tag({ children }: { children: React.ReactNode }) {
  return (
    <Badge variant="soft" className="mb-3.5 h-auto px-3 py-[3px] text-[13px] text-brand-400">
      {children}
    </Badge>
  )
}

/** The two lit buttons; the hero and the closing panel repeat them. */
export function CtaButtons({ appUrl, className }: { appUrl: string; className?: string }) {
  // On a phone the buttons share the row evenly: a button that shrinks to its text looks accidental
  // next to a full-width one.
  // min-h, not h: at a very large text size the label wraps and the button grows instead of overflowing.
  const size = 'h-auto min-h-13.5 flex-auto px-7 leading-[1.6] whitespace-normal min-[720.02px]:flex-none'
  // `glass` paints its own faint border later in the stylesheet than any border-color utility, so the
  // button's edge (the 3:1 line) has to be forced.
  // The press does not nudge it either: only the lit button ever moved.
  const outline = cn('border-line-strong! hover:border-dim! hover:bg-glass active:not-aria-[haspopup]:translate-y-0', FOCUS_RING)
  return (
    <div className={cn('mt-6 mb-3 flex flex-wrap gap-3 min-[720.02px]:mt-8 min-[720.02px]:mb-4', className)}>
      <Button asChild className={cn(size, LIT_BUTTON)}>
        <a href={appUrl}>Открыть приложение</a>
      </Button>
      <Button asChild variant="outline" className={cn(size, outline)}>
        <Link href="/download">Скачать на телефон</Link>
      </Button>
    </div>
  )
}

export function Steps({ children }: { children: React.ReactNode }) {
  // Five steps in one column became 1200px-long lines. Two columns from a tablet (the odd last step takes
  // the whole row); from 1180px a six-track grid: three across, then two wider ones, so no row has a hole.
  return (
    <ol className="mt-6 grid list-none gap-3.5 p-0 [counter-reset:step] min-[720.02px]:mt-9 min-[720.02px]:grid-cols-2 min-[720.02px]:gap-[18px] min-[720.02px]:max-[1180px]:[&>:last-child:nth-child(odd)]:col-span-2 min-[1180px]:grid-cols-6">
      {children}
    </ol>
  )
}

export function Step({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <li
      className={cn(
        PANE,
        TINT,
        'rounded-xl py-[18px] pr-[18px] pl-16 [counter-increment:step] *:relative min-[720.02px]:py-5 min-[720.02px]:pr-[22px] min-[720.02px]:pl-[70px] min-[1180px]:col-span-2 min-[1180px]:nth-[n+4]:col-span-3',
        // The glow is ::after, the step number is ::before.
        'after:absolute after:-top-[35%] after:-right-[25%] after:aspect-square after:w-[70%] after:rounded-full after:bg-[radial-gradient(circle,rgba(var(--tint),0.3),transparent_70%)] after:pointer-events-none',
        'before:absolute before:top-[18px] before:left-4 before:flex before:size-9 before:items-center before:justify-center before:rounded-full before:border before:border-brand-line before:bg-[linear-gradient(180deg,rgba(var(--ryadom-brand-rgb),0.32),rgba(var(--ryadom-brand-rgb),0.12))] before:text-[15px] before:font-[650] before:text-brand-400 before:content-[counter(step)] min-[720.02px]:before:top-5 min-[720.02px]:before:left-5',
      )}
    >
      <H3 className="mb-1.5">{title}</H3>
      <p className="text-dim">{children}</p>
    </li>
  )
}

export function Checklist({ children }: { children: React.ReactNode }) {
  return <ul className="mt-7 grid list-none gap-3.5 p-0">{children}</ul>
}

export function CheckItem({ lead, children }: { lead: string; children: React.ReactNode }) {
  return (
    <li className="relative pl-8 text-dim before:absolute before:top-2.5 before:left-1 before:size-2.5 before:rounded-full before:bg-brand before:shadow-[0_0_12px_rgba(var(--ryadom-brand-rgb),0.7)]">
      <strong className="font-semibold text-foreground">{lead}</strong> {children}
    </li>
  )
}
