import { MEMORY_RECAP, type MemoryRecapState } from '@ryadom/client-core/memory'

/**
 * The block "Я запомнил" in the window after a conversation: the notes that came out of it, each with "Убрать". It is drawn into the
 * Framework7 dialog through a portal (`DialogPage`). The texts are the person's own words: the block is left out of click capture
 * (`ph-no-capture`), and nothing here stores or reports them. "Убрать" deletes at once, without "Вернуть"; a deletion that did not go
 * through leaves the note and says so beside it.
 */
export default function MemoryRecap({
  state,
  onRemove,
}: {
  state: MemoryRecapState
  onRemove(id: string): void
}) {
  return (
    <section
      className="rd-remembered ph-no-capture"
      aria-labelledby="rd-remembered-title"
      data-testid="memory-recap"
    >
      <h3 className="rd-remembered-title" id="rd-remembered-title">
        {MEMORY_RECAP.title}
      </h3>
      <ul className="rd-remembered-list">
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
      {state.more > 0 && (
        <p className="rd-remembered-more" data-testid="memory-recap-more">
          {MEMORY_RECAP.more}
        </p>
      )}
    </section>
  )
}
