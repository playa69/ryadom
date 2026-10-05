import type { ComponentProps } from 'react'
import type { DialogListItemApiResponse } from '@ryadom/contracts/api/dialogs'
import { Button } from '@ryadom/ui/components/button'
import { Card } from '@ryadom/ui/components/card'
import { cn } from '@ryadom/ui/lib/utils'
import { BUSY } from './busy'
import { BUTTON } from './controls'

/** A badge sized for a line of text: the shared one is a fixed 24px chip, too tight once the text wraps. */
export const BADGE_COMPACT = 'h-auto py-[3px] leading-[1.4]'

/**
 * Where a conversation opens. The same rule as the sidebar: an open one is resumed in the dialog
 * screen (there is only ever one, and the API resumes it), a finished one opens read-only.
 */
export function conversationHref({
  dialogId,
  endedAt,
}: Pick<DialogListItemApiResponse, 'dialogId' | 'endedAt'>): string {
  const id = encodeURIComponent(dialogId)
  return endedAt ? `/journal/${id}` : `/dialog/${id}`
}

/** A flat glass pane with a short message and, maybe, one action: empty states and load errors. */
export function StatePanel({ className, ...props }: ComponentProps<typeof Card>) {
  return (
    <Card
      className={cn('items-center gap-4 rounded-lg px-5 py-10 text-center shadow-none', className)}
      {...props}
    />
  )
}

/** While it waits the label stays, so the button keeps its width, and a spinner comes in front of it. */
export function RetryButton({ busy, onClick }: { busy?: boolean; onClick(): void }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn(BUTTON, BUSY, 'px-4')}
      aria-busy={busy}
      onClick={onClick}
    >
      Попробовать ещё раз
    </Button>
  )
}
