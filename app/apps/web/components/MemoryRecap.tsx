'use client'

import { Button } from '@ryadom/ui/components/button'
import { cn } from '@ryadom/ui/lib/utils'
import { MEMORY_RECAP, type MemoryRecapState } from '@ryadom/client-core/memory'
import { BUTTON } from './controls'
import { NoCapture } from './NoCapture'
import { SECTION_HEADING } from './Page'

/**
 * The block "Я запомнил" in the window after a conversation: the notes that came out of it, each with "Убрать". The texts are the
 * person's own words, so the block is left out of click capture (`NoCapture`), and nothing here stores or reports them.
 * "Убрать" deletes at once, without "Вернуть"; a deletion that did not go through leaves the note and says so beside it.
 */
export default function MemoryRecap({
  state,
  onRemove,
}: {
  state: MemoryRecapState
  onRemove(id: string): void
}) {
  return (
    <NoCapture>
      <section
        className="flex flex-col gap-2 rounded-lg border border-brand-line bg-brand-soft px-4 py-3"
        aria-labelledby="memory-recap-title"
        data-testid="memory-recap"
      >
        <h3 id="memory-recap-title" className={SECTION_HEADING}>
          {MEMORY_RECAP.title}
        </h3>
        <ul className="flex flex-col gap-2">
          {state.items.map((note) => (
            <li key={note.id} className="flex flex-col gap-1" data-testid="memory-recap-note">
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
        {state.more > 0 && (
          <p className="text-[0.8125rem] leading-[1.4] text-faint" data-testid="memory-recap-more">
            {MEMORY_RECAP.more}
          </p>
        )}
      </section>
    </NoCapture>
  )
}
