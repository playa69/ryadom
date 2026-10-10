'use client'

import { Phone } from 'lucide-react'
import type { ComponentProps } from 'react'
import { trackAnonymous } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import type { HotlineApiResponse } from '@ryadom/contracts/api/dialogs'
import { telHref } from '@ryadom/client-core/hotlines'
import { Item, ItemActions, ItemContent } from '@ryadom/ui/components/item'
import { cn } from '@ryadom/ui/lib/utils'
import { FOCUS_RING } from './controls'

/**
 * One help line as a tappable glass row (the SOS sheet and the "people nearby" screen). Name over
 * number in every row: side by side only while the name is short would lay neighbours out
 * differently (112 on one line, the others on two).
 *
 * `showCallIcon` adds a phone glyph at the end of the row: on a wide page a row is mostly empty
 * space, and the glyph says that it is a call. The narrow SOS sheet does without.
 */
export default function Hotline({
  hotline,
  showCallIcon = false,
  className,
  onClick,
  ...props
}: { hotline: HotlineApiResponse; showCallIcon?: boolean } & Omit<ComponentProps<'a'>, 'href' | 'children'>) {
  return (
    <Item
      asChild
      variant="outline"
      className={cn(
        // The glass fill without its blur: in the sheet the row sits on a pane that already blurs the page,
        // and a second backdrop filter per row only costs compositing. Hover keeps the lift, not an opaque fill.
        'min-h-11 flex-nowrap bg-glass p-4 shadow-(--ryadom-highlight) [a]:hover:bg-glass [a]:hover:brightness-[1.12]',
        FOCUS_RING,
        className,
      )}
    >
      <a
        href={telHref(hotline.phone)}
        {...props}
        onClick={(event) => {
          // A count per line (a fixed public list), attached to nobody.
          trackAnonymous(AnalyticsEvent.HotlineCalled, { hotline: hotline.name })
          onClick?.(event)
        }}
      >
        <ItemContent className="gap-0.5">
          <span className="text-[0.9375rem] font-semibold text-foreground">{hotline.name}</span>
          <span className="text-[0.9375rem] font-bold text-sos">{hotline.phone}</span>
        </ItemContent>
        {showCallIcon && (
          <ItemActions className="shrink-0">
            <span
              className="grid size-10 place-items-center rounded-full border border-line bg-white/5 text-sos"
              aria-hidden="true"
            >
              <Phone className="size-[18px]" />
            </span>
          </ItemActions>
        )}
      </a>
    </Item>
  )
}
