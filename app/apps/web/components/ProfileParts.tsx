'use client'

import { useId, type ComponentProps, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Button } from '@ryadom/ui/components/button'
import { Card } from '@ryadom/ui/components/card'
import { Spinner } from '@ryadom/ui/components/spinner'
import { cn } from '@ryadom/ui/lib/utils'
import { BUTTON, FOCUS_RING } from './controls'
import { SECTION_HEADING } from './Page'

/** Pieces shared by the three settings screens (inside a Page), so each screen reads as its content only. */

/** A field in error keeps only its red border; once it has focus the ring shows as usual. */
export const FIELD_FOCUS = `${FOCUS_RING} aria-invalid:ring-0 aria-invalid:focus-visible:ring-2 aria-invalid:focus-visible:ring-ring`

/**
 * The shared Button with the product focus ring and a fill that reaches under the transparent
 * border (or it looks a pixel smaller than its box). While `aria-busy` the press is ignored by
 * pointer-events and not by `disabled`, so focus stays. Forced-colors mode: the shared Button's
 * `outline-hidden` is a permanent 2px outline there, which doubles the border of an outline button;
 * it is off, and FOCUS_RING draws the outline on focus.
 */
export function ProfileButton({ variant = 'default', className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      variant={variant}
      className={cn(
        BUTTON,
        'leading-[1.2] aria-busy:pointer-events-none forced-colors:outline-none',
        variant === 'outline' ? 'border-input' : 'bg-clip-border focus-visible:border-transparent',
        className,
      )}
      {...props}
    />
  )
}

/**
 * A small quiet heading over one card of rows. A plain group, not a <section>: a named section is a
 * region landmark, and five of them on one page would crowd the screen reader's landmark list. The
 * h2 gives the structure and names the list.
 */
export function SettingsSection({
  title,
  testId,
  danger,
  note,
  children,
}: {
  title: string
  testId?: string
  danger?: boolean
  /** A line of explanation under the card. */
  note?: string
  children: ReactNode
}) {
  const id = useId()
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h2 id={id} className={SECTION_HEADING}>
        {title}
      </h2>
      <SettingsList danger={danger} testId={testId} labelledBy={id}>
        {children}
      </SettingsList>
      {note && <p className="px-1 text-[0.8125rem] leading-[1.45] text-faint">{note}</p>}
    </div>
  )
}

/**
 * Rows in one glass card with hairlines between them. The card clips its content, so each row takes
 * the card's radius through `inherit` (only the first and last at the outer corners): the inset focus
 * ring and the hover fill then follow the corner.
 */
function SettingsList({
  danger = false,
  testId,
  labelledBy,
  children,
}: {
  danger?: boolean
  testId?: string
  labelledBy?: string
  children: ReactNode
}) {
  return (
    <Card className={cn('gap-0 rounded-lg py-0', danger && 'border-danger-line')}>
      <ul
        data-testid={testId}
        aria-labelledby={labelledBy}
        className="rounded-[inherit] [&>li:first-child]:rounded-t-[inherit] [&>li:last-child]:rounded-b-[inherit] [&>li+li]:border-t [&>li+li]:border-line [&>li>*]:rounded-[inherit]"
      >
        {children}
      </ul>
    </Card>
  )
}

/**
 * What a row of a settings list looks like, on top of Item: 56px tall (48px on a desktop, where the pointer is finer and the whole page should fit a laptop window), no border of its own, and a
 * focus ring drawn inside, because the card around it would cut an outer one off. Forced-colors mode
 * drops the ring (a shadow) and Item's `outline-hidden` there is a permanent outline offset by 2px,
 * which the card clips and which shows as a double line between rows: so in that mode the outline
 * is off, and on focus it is drawn inside the row.
 */
export const ROW =
  'min-h-14 flex-nowrap border-0 tab:min-h-12 px-4 py-2.5 text-left text-base leading-[1.35] font-medium text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring forced-colors:outline-none forced-colors:focus-visible:outline-2 forced-colors:focus-visible:-outline-offset-2 forced-colors:focus-visible:outline-solid'

/** The bare glyph at the start of a row: no tile around it, a desktop list is read by its labels. */
export function RowIcon({
  icon: Icon,
  danger = false,
  className,
}: {
  icon: LucideIcon
  danger?: boolean
  className?: string
}) {
  return (
    <Icon
      className={cn('size-[18px] shrink-0 text-dim', danger && 'text-danger', className)}
      strokeWidth={1.8}
      aria-hidden="true"
    />
  )
}

export function ModalText({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-base leading-[1.55] text-dim', className)} {...props} />
}

export function ModalActions({ children }: { children: ReactNode }) {
  return <div className="mt-2 flex gap-3 *:flex-1 *:px-4">{children}</div>
}

/** A button's loading state: the label stays, so the button keeps its meaning, and a spinner comes in front. */
export function Busy({ on }: { on: boolean }) {
  if (!on) return null
  return (
    <Spinner
      aria-hidden="true"
      role="presentation"
      // Lucide draws its arc at 3/4 of the box. At 7/6 em the arc is the 16px ring of a 2px border on a
      // 1em box, with the same 2px line; the negative margin keeps the 1em footprint in the button.
      strokeWidth={2.57}
      className="-mx-[0.0833em] size-[1.1667em] animate-[spin_0.7s_linear_infinite] motion-reduce:animate-[spin_2s_linear_infinite]"
    />
  )
}
