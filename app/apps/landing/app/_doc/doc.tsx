import * as React from 'react'
import { Card, CardContent } from '@ryadom/ui/components/card'
import { cn } from '@ryadom/ui/lib/utils'

/*
 * Building blocks of the document-like pages (privacy, terms, delete-account, download, 404).
 * Every number here is the old site's: a 17px/1.6 body (18px from 1280px), a side gutter that
 * grows with the viewport, and one phone step at 720px, so the phone variants are not Tailwind's
 * sm. Tailwind's max-* is exclusive (width < X) while the old phone range was width <= 720px: the
 * .1 keeps a 720px window on the phone side (a media query is only exact to 1/64px).
 */

/** The side gutter: grows with the viewport, steps down on phones (360px is the floor we support). */
const gutter = 'px-[clamp(20px,4vw,48px)] max-[720.1px]:px-[18px] max-[400.1px]:px-4'

/** Reading size. Wider containers get 18px so the copy does not read as small print in a void. */
const bodyType = 'text-[17px] leading-[1.6] text-pretty min-[1280px]:text-[18px]'

/**
 * Buttons in these pages are 48px tall, a step under the shared 52px default, and keep their fill
 * under the 1px border: the lit gradient reaches the very edge of the pill.
 */
export const pageButton = 'h-auto min-h-12 bg-clip-border px-6 leading-[1.6]'

/** The lit primary button rises a pixel on hover. */
export const pageButtonLift = 'hover:-translate-y-px hover:brightness-[1.06]'

/*
 * The glass utility sorts after the border utilities, so its 10% hairline would beat the 3:1
 * boundary a button needs (WCAG 1.4.11); the important marks keep the stronger line, hover included.
 */
export const pageButtonOutline = 'border-input! hover:border-muted-foreground!'

/** An inline link inside copy: blue, underlined only when pointed at. */
export const inlineLink = 'text-brand-400 hover:underline'

/**
 * The box every page shares with the header and the footer: the same maximum width and the same
 * gutter, so the logo, the text and the footer links start on one vertical line at any window width.
 * Documents fill it edge to edge, like the header above and the footer below.
 */
const container = cn('mx-auto w-full max-w-[1320px]', gutter)

/**
 * A legal document: the typography plugin carries the headings, lists and links, tuned to the
 * site's scale. Browsers' default list margins are gone with the reset, so they are spelled out.
 */
export function LegalDocument({ className, children, ...props }: React.ComponentProps<'main'>) {
  return (
    <main
      className={cn(container, 'pt-14 pb-20 text-foreground max-[720.1px]:pt-8 max-[720.1px]:pb-14', bodyType)}
      {...props}
    >
      <div
        className={cn(
          'prose prose-invert max-w-none',
          // The plugin's palette, replaced with the product's: links in the light blue that reads on the night sky, list marks like the list text.
          '[--tw-prose-headings:var(--ryadom-text)] [--tw-prose-links:var(--ryadom-brand-400)] [--tw-prose-bullets:var(--ryadom-text-dim)] [--tw-prose-counters:var(--ryadom-text-dim)]',
          // "конфиденциальности" at the page-title size is wider than a phone's content column.
          'prose-h1:mt-0 prose-h1:mb-4 prose-h1:text-[clamp(28px,7.4vw,44px)] prose-h1:leading-[1.15] prose-h1:font-[650] prose-h1:tracking-display-tight prose-h1:wrap-break-word prose-h1:hyphens-auto prose-h1:text-balance',
          'prose-h2:mt-11 prose-h2:mb-4 prose-h2:text-[24px] prose-h2:leading-[1.15] prose-h2:font-[650] prose-h2:tracking-display-tight prose-h2:text-balance max-[720.1px]:prose-h2:mt-7',
          'prose-p:mt-0 prose-p:mb-4',
          'prose-strong:font-bold prose-strong:text-inherit',
          'prose-a:font-normal prose-a:no-underline [&_a:hover]:underline',
          'prose-ul:my-[1em] prose-ul:ps-[22px] prose-ul:text-muted-foreground prose-ol:my-[1em] prose-ol:ps-[22px] prose-ol:text-muted-foreground',
          'prose-li:mt-0 prose-li:mb-2 prose-li:ps-0',
          className,
        )}
      >
        {children}
      </div>
    </main>
  )
}

/** A page of blocks (download): the shared container, full width. Block padding only: the gutter stays. */
export function PageMain({ className, ...props }: React.ComponentProps<'main'>) {
  return <main className={cn(container, 'py-[72px] max-[720.1px]:py-[30px]', bodyType, className)} {...props} />
}

/** The page-wide shell without the 720px column, for a page that centers its own block (404). */
export function WideMain({ className, ...props }: React.ComponentProps<'main'>) {
  return <main className={cn(container, bodyType, className)} {...props} />
}

export function PageTitle({ className, ...props }: React.ComponentProps<'h1'>) {
  return (
    <h1
      className={cn(
        'mb-4 text-[clamp(38px,9vw,56px)] leading-[1.15] font-[650] tracking-display-tight text-balance min-[1280px]:text-[clamp(56px,4.6vw,64px)]',
        className,
      )}
      {...props}
    />
  )
}

/** The paragraph under a title: one step larger and dimmer than the copy. */
export function Lead({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      className={cn(
        'mb-4 text-[19px] text-muted-foreground max-[720.1px]:text-[18px] min-[1280px]:text-[21px]',
        className,
      )}
      {...props}
    />
  )
}

/*
 * A wash of aurora behind a section, on alternating sides: the page background is fixed, so
 * without these a long page reads as one flat field once you scroll past the first screen. The
 * ellipse fades out exactly at the section's own box, so no edge shows and nothing overflows.
 */
const sectionBase =
  'relative before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:bg-[radial-gradient(28%_50%_at_var(--glow-x)_50%,rgba(var(--glow),0.2),transparent)]'

const tints = {
  teal: '[--glow-x:28%] [--glow:var(--ryadom-teal-rgb)]',
  indigo: '[--glow-x:72%] [--glow:var(--ryadom-indigo-rgb)]',
  violet: '[--glow-x:28%] [--glow:var(--ryadom-violet-rgb)]',
} as const

export function Section({
  tint = 'teal',
  className,
  ...props
}: React.ComponentProps<'section'> & { tint?: keyof typeof tints }) {
  return <section className={cn(sectionBase, tints[tint], className)} {...props} />
}

/** Actions of a section. On a phone they share the row, so one never looks accidental next to another. */
export function ButtonRow({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'mt-8 mb-4 flex flex-wrap gap-3 max-[720.1px]:mt-6 max-[720.1px]:mb-3 max-[720.1px]:*:flex-auto',
        className,
      )}
      {...props}
    />
  )
}

/** The one thing a reader must not miss: a lit pane with a blue edge. */
export function Callout({ className, children, ...props }: React.ComponentProps<typeof Card>) {
  return (
    <Card
      className={cn(
        // Important: the glass surface sorts after border and shadow utilities and would erase them.
        'my-7 rounded-lg border-l-[3px]! border-l-brand! py-5 text-[1em] shadow-card! max-[720.1px]:py-4',
        className,
      )}
      {...props}
    >
      <CardContent className="px-6 max-[720.1px]:px-[18px] [&>:last-child]:mb-0">{children}</CardContent>
    </Card>
  )
}

/*
 * A table of prose cannot fit a phone, and sideways scrolling hides exactly the column a reader
 * needs. So on a phone each row becomes its own block with the column name in front of the value
 * (every cell carries it in data-label); the header row stays for screen readers only.
 */
export function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <table
      data-slot="table"
      className={cn(
        // not-prose: the typography plugin styles tables too, and this one is fully ours.
        'not-prose my-5 w-full border-separate border-spacing-0 overflow-hidden rounded-lg border border-line bg-glass text-[15px]',
        'max-[720.1px]:block max-[720.1px]:border-0 max-[720.1px]:bg-transparent',
        className,
      )}
      {...props}
    />
  )
}

export function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={cn('max-[720.1px]:sr-only', className)} {...props} />
}

export function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return (
    <tbody
      data-slot="table-body"
      className={cn(
        '[&>tr:last-child>td]:border-b-0 max-[720.1px]:block max-[720.1px]:w-full',
        className,
      )}
      {...props}
    />
  )
}

export function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        'max-[720.1px]:mb-3 max-[720.1px]:block max-[720.1px]:w-full max-[720.1px]:rounded-(--ryadom-r-s) max-[720.1px]:border max-[720.1px]:border-line max-[720.1px]:bg-glass max-[720.1px]:py-1',
        className,
      )}
      {...props}
    />
  )
}

export function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        'border-b border-line bg-glass-2 px-3.5 py-3 text-left align-top font-semibold',
        className,
      )}
      {...props}
    />
  )
}

export function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        'border-b border-line px-3.5 py-3 text-left align-top text-balance text-muted-foreground',
        'max-[720.1px]:block max-[720.1px]:w-full max-[720.1px]:border-0 max-[720.1px]:px-4 max-[720.1px]:py-2',
        'max-[720.1px]:before:mb-0.5 max-[720.1px]:before:block max-[720.1px]:before:text-[13px] max-[720.1px]:before:text-foreground max-[720.1px]:before:content-[attr(data-label)]',
        className,
      )}
      {...props}
    />
  )
}
