import { MessageCircle, MessageCirclePlus } from 'lucide-react'
import Link from 'next/link'
import type { DialogApiResponse, DialogSummaryApiResponse } from '@ryadom/contracts/api/dialogs'
import { Badge } from '@ryadom/ui/components/badge'
import { Button } from '@ryadom/ui/components/button'
import { Card } from '@ryadom/ui/components/card'
import { cn } from '@ryadom/ui/lib/utils'
import { formatJournalDate } from '@/lib/journal'
import { BUTTON } from './controls'
import { ChatMessage } from './ChatMessage'
import { DeleteDialogButton, RecapBlock, UnsavedMark } from './JournalEntryRecap'
import { BADGE_COMPACT, conversationHref, StatePanel } from './JournalParts'

/** "7 → 4", or "было 7" while the conversation has no closing score (the list row says the same). */
function entryTension({ tensionBefore, tensionAfter }: DialogSummaryApiResponse): string | null {
  if (tensionAfter !== null) return `${tensionBefore ?? '—'} → ${tensionAfter}`
  return tensionBefore !== null ? `было ${tensionBefore}` : null
}

/**
 * When it was, what it was about and how the tension moved: the summary the agent wrote, in a pane.
 * A conversation without a summary (still open, or the agent never wrote one) gets just the date. The
 * header clips a long title to one line (two on a phone), so the pane carries it in full; the page
 * heading already has it for screen readers.
 */
function EntryMeta({ dialog }: { dialog: DialogApiResponse }) {
  const { summary } = dialog
  const tension = summary ? entryTension(summary) : null
  const body = (
    <>
      {summary && (
        <p aria-hidden="true" className="text-xl leading-tight font-bold tracking-display wrap-anywhere">
          {summary.title || 'Разговор'}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <time className="text-[0.8125rem] text-faint tabular-nums" dateTime={dialog.startedAt}>
          {formatJournalDate(dialog.startedAt)}
        </time>
        {!dialog.endedAt && (
          <Badge variant="soft" className={BADGE_COMPACT}>
            Не завершён
          </Badge>
        )}
        {tension && (
          <Badge variant="sage" className={cn(BADGE_COMPACT, 'font-bold')}>
            Напряжение: {tension}
          </Badge>
        )}
      </div>
      {summary &&
        (summary.themes.length > 0 ? (
          <ul className="flex flex-wrap gap-2" aria-label="Темы">
            {summary.themes.map((theme) => (
              <li key={theme} className="max-w-full">
                <Badge
                  variant="outline"
                  className="h-auto max-w-full py-1 text-[0.8125rem] whitespace-normal text-dim wrap-anywhere"
                >
                  {theme}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-base leading-normal text-dim">Без тем</p>
        ))}
    </>
  )

  return summary ? (
    <Card className="gap-3 rounded-lg px-4 py-4 shadow-none tab:px-5" data-testid="journal-summary">
      {body}
    </Card>
  ) : (
    <div className="flex flex-col gap-3">{body}</div>
  )
}

/**
 * A past conversation, read-only: the summary, then the transcript drawn exactly as the live dialog
 * draws it, then a calm way to carry on. A finished one carries on in a new conversation; an open one
 * (there is only ever one, and the API resumes it) goes back to where it left off, and says so. The
 * route (JournalEntryScreen) owns the header and the loading; this is the ready state.
 */
export default function JournalEntry({
  dialog,
  onSummary,
  onRefresh,
  onDeleted,
}: {
  dialog: DialogApiResponse
  onSummary(summary: DialogSummaryApiResponse): void
  onRefresh(): void
  onDeleted(): void
}) {
  const isOpen = !dialog.endedAt
  // A conversation the person asked not to keep leaves only a mark: no text, no recap, no way to carry on.
  if (dialog.saved === false) {
    return (
      <>
        <UnsavedMark dialog={dialog} />
        <div className="flex justify-center border-t border-line pt-8">
          <DeleteDialogButton dialogId={dialog.dialogId} label="Удалить пометку" onDeleted={onDeleted} />
        </div>
      </>
    )
  }
  return (
    <>
      <EntryMeta dialog={dialog} />
      <RecapBlock dialog={dialog} onSummary={onSummary} onRefresh={onRefresh} />

      {dialog.messages.length > 0 ? (
        <ol className="flex flex-col gap-6" aria-label="Текст разговора" data-testid="journal-messages">
          {dialog.messages.map((message) => (
            <ChatMessage key={message.id} role={message.role}>
              {message.text}
            </ChatMessage>
          ))}
        </ol>
      ) : (
        <StatePanel data-testid="journal-entry-empty">
          <p className="leading-[1.55] text-muted-foreground">Текст этого разговора не сохранён.</p>
        </StatePanel>
      )}

      <div className="flex justify-center border-t border-line pt-8">
        <Button
          asChild
          variant="outline"
          size="sm"
          className={cn(BUTTON, 'h-auto min-h-11 max-w-full py-2 text-center whitespace-normal')}
          data-testid="journal-continue"
        >
          <Link href={isOpen ? conversationHref(dialog) : '/home'}>
            {isOpen ? <MessageCircle aria-hidden="true" /> : <MessageCirclePlus aria-hidden="true" />}
            {isOpen ? 'Вернуться к разговору' : 'Продолжить в новом разговоре'}
          </Link>
        </Button>
      </div>
      {!isOpen && (
        <div className="flex justify-center">
          <DeleteDialogButton dialogId={dialog.dialogId} label="Удалить разговор" onDeleted={onDeleted} />
        </div>
      )}
    </>
  )
}
