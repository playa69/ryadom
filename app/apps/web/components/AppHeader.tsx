'use client'

import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { Button } from '@ryadom/ui/components/button'
import { SidebarTrigger } from '@ryadom/ui/components/sidebar'
import { cn } from '@ryadom/ui/lib/utils'
import { SosButton } from './Sos'

/** Two lines on a phone (a clipped title names nothing), one from 700px where there is room. */
const TITLE =
  'min-w-0 flex-1 line-clamp-2 text-base leading-tight font-semibold tracking-display text-foreground tab:line-clamp-1'

/**
 * The bar at the top of every signed-in screen: the menu button (a drawer on a phone, a collapse
 * toggle on a desktop), an optional way back, the screen's title, the screen's own actions and, always
 * last and always there, SOS. Each screen renders its own, so it decides the title and the actions;
 * the bar stays put while the page scrolls.
 *
 * It holds the screen's h1 unless `titleIsHeading` is false, so a screen must not add a second one.
 */
export function AppHeader({
  title,
  titleIsHeading = true,
  back,
  actions,
  className,
}: {
  title?: ReactNode
  /** False when the screen's own content carries the h1 (the home greeting): the title is then plain text. */
  titleIsHeading?: boolean
  /** A way back to the parent screen (settings subpages, a journal entry). */
  back?: { href: string; label: string }
  /** Buttons that belong to this screen, placed before SOS (for example "end the conversation"). */
  actions?: ReactNode
  className?: string
}) {
  return (
    <header
      data-slot="app-header"
      className={cn(
        'sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-bars px-3 pt-[env(safe-area-inset-top,0px)] [-webkit-backdrop-filter:var(--ryadom-blur)] [backdrop-filter:var(--ryadom-blur)] box-content tab:px-4',
        className,
      )}
    >
      <SidebarTrigger className="size-11 shrink-0 text-dim" />
      {back && (
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="shrink-0 px-3 text-dim max-[26rem]:min-w-11 max-[26rem]:px-0"
        >
          <Link href={back.href}>
            <ArrowLeft />
            {/* A phone has no room for the word as well as the title, and the title is the page's only name: the word stays for screen readers. */}
            <span className="max-[26rem]:sr-only">{back.label}</span>
          </Link>
        </Button>
      )}
      {titleIsHeading ? <h1 className={TITLE}>{title}</h1> : <p className={TITLE}>{title}</p>}
      {actions}
      <SosButton className="shrink-0" />
    </header>
  )
}
