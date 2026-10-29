'use client'

import { Button } from '@ryadom/ui/components/button'
import { cn } from '@ryadom/ui/lib/utils'
import { MEMORY_RECAP, type MemoryRecapState } from '@ryadom/client-core/memory'
import { BUTTON } from './controls'
import { NoCapture } from './NoCapture'
import { SECTION_HEADING } from './Page'

/**
 * The block "Я запомнил" in the window after a conversation: all the notes that came out of it, each with "Убрать". About three of
 * them are in view, the rest are reached by scrolling the list itself (its edges fade where there is more, and the list takes the
 * keyboard, so arrow keys scroll it). The texts are the person's own words, so the block is left out of click
 * capture (`NoCapture`), and nothing here stores or reports them. "Убрать" deletes at once, without "Вернуть"; a deletion that did
 * not go through leaves the note and says so beside it.
 *
 * When the final pass was still going after the half minute the app waits (`late`), there is no block: only a calm line under the
 * text of the window, which tells where the notes will be.
 */
export default function MemoryRecap({
  state,
  onRemove,
}: {
  state: MemoryRecapState
  onRemove(id: string): void
}) {
  if (state.kind === 'late') {
    return (
      <p className="text-base leading-[1.55] text-dim" role="status" aria-live="polite" data-testid="memory-recap-late">
        {MEMORY_RECAP.late}
      </p>
    )
  }
  return (
    <NoCapture>
      <section
        // The list below carries the padding above and under the notes: its fades need room there, or the first and the last note would stay faded.
        className="flex flex-col gap-0.5 rounded-lg border border-brand-line bg-brand-soft px-4 pt-3 pb-0"
        aria-labelledby="memory-recap-title"
        data-testid="memory-recap"
      >
        <h3 id="memory-recap-title" className={SECTION_HEADING}>
          {MEMORY_RECAP.title}
        </h3>
        <ul
          role="list"
          aria-label="Заметки этого разговора"
          // A scrolling area is reached by keyboard too. The ring is drawn inside: the fade below clips whatever lies outside the box.
          tabIndex={0}
          className={cn(
            '-mx-1 flex max-h-[min(10rem,35dvh)] flex-col gap-2 overflow-y-auto overscroll-contain rounded-md px-1 pt-1.5 pb-3',
            // The edges fade where there is more to scroll to (and the padding keeps the notes clear of the fade when there is not).
            '[mask-image:linear-gradient(to_bottom,transparent,#000_0.375rem,#000_calc(100%-0.75rem),transparent)]',
            'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-transparent',
          )}
          data-testid="memory-recap-list"
        >
          {state.items.map((note) => (
            <li key={note.id} className="flex shrink-0 flex-col gap-1" data-testid="memory-recap-note">
              <div className="flex items-start gap-2">
                <p
                  className="min-w-0 flex-1 py-1.5 text-base leading-[1.45] wrap-anywhere text-foreground"
                  data-testid="memory-recap-text"
                >
                  {note.text}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className={cn(BUTTON, 'h-9 shrink-0 px-2.5 text-sm text-dim hover:text-foreground')}
                  disabled={state.busyId !== null}
                  aria-label={`${MEMORY_RECAP.remove}: ${note.text}`}
                  onClick={() => onRemove(note.id)}
                  data-testid="memory-recap-remove"
                >
                  {MEMORY_RECAP.remove}
                </Button>
              </div>
              {state.errors[note.id] && (
                <p
                  className="text-[0.875rem] leading-[1.4] text-danger"
                  role="alert"
                  data-testid="memory-recap-error"
                >
                  {state.errors[note.id]}
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>
    </NoCapture>
  )
}
