import { MEMORY_RECAP, type MemoryRecapState } from '@ryadom/client-core/memory'

/**
 * The block "Я запомнил" in the window after a conversation: all the notes that came out of it, each with "Убрать". It is drawn into the
 * Framework7 dialog through a portal (`DialogPage`). About three notes are in view, the rest are reached by scrolling the list itself
 * (its edges fade where there is more, and the list takes the keyboard). The texts are the person's own words: the block
 * is left out of click capture (`ph-no-capture`), and nothing here stores or reports them. "Убрать" deletes at once, without "Вернуть";
 * a deletion that did not go through leaves the note and says so beside it.
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
      <p className="rd-remembered-late" role="status" aria-live="polite" data-testid="memory-recap-late">
        {MEMORY_RECAP.late}
      </p>
    )
  }
  return (
    <section
      className="rd-remembered ph-no-capture"
      aria-labelledby="rd-remembered-title"
      data-testid="memory-recap"
    >
      <h3 className="rd-remembered-title" id="rd-remembered-title">
        {MEMORY_RECAP.title}
      </h3>
      {/* A scrolling area is reached by keyboard too. */}
      <ul
        className="rd-remembered-list"
        role="list"
        aria-label="Заметки этого разговора"
        tabIndex={0}
        data-testid="memory-recap-list"
      >
        {state.items.map((note) => (
          <li key={note.id} className="rd-remembered-note" data-testid="memory-recap-note">
            <div className="rd-remembered-row">
              <span className="rd-remembered-text" data-testid="memory-recap-text">
                {note.text}
              </span>
              <button
                type="button"
                className="rd-remembered-remove"
                disabled={state.busyId !== null}
                aria-label={`${MEMORY_RECAP.remove}: ${note.text}`}
                onClick={() => onRemove(note.id)}
                data-testid="memory-recap-remove"
              >
                {MEMORY_RECAP.remove}
              </button>
            </div>
            {state.errors[note.id] && (
              <span className="rd-form-error" role="alert" data-testid="memory-recap-error">
                {state.errors[note.id]}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
