import { Button, Sheet } from 'framework7-react'
import { MEMORY_CONSENT, MEMORY_HOW_IT_WORKS } from '@ryadom/client-core/memory'

/**
 * The consent sheet "Память", shown when the person turns memory on for the first time (or the text
 * has a new version). A separate document, not a clause of the terms: memory can be left off with
 * nothing else lost. The same sheet without the buttons of the answer is "Как это работает".
 * The text is a draft for the lawyer and the psychologist (see MEMORY_CONSENT).
 */
export default function MemoryConsentSheet({
  opened,
  kind,
  busy,
  error,
  onAccept,
  onClose,
}: {
  opened: boolean
  /** `consent` asks for the answer; `info` only explains. */
  kind: 'consent' | 'info'
  busy: boolean
  error: string
  onAccept: () => void
  /** The close button, a swipe or a tap outside: memory stays as it was. */
  onClose: () => void
}) {
  const consent = kind === 'consent'
  const paragraphs = consent ? MEMORY_CONSENT.paragraphs : MEMORY_HOW_IT_WORKS
  return (
    <Sheet
      opened={opened}
      onSheetClosed={onClose}
      swipeToClose={!busy}
      closeOnEscape={!busy}
      backdrop
      style={{ height: 'auto' }}
    >
      <div className="rd-sheet-body rd-sheet-scroll" data-testid="memory-consent">
        <h2 className="rd-sheet-title">{consent ? MEMORY_CONSENT.title : 'Как это работает'}</h2>
        {paragraphs.map((text) => (
          <p key={text} className="rd-muted rd-memory-paragraph">
            {text}
          </p>
        ))}
        {consent && <p className="rd-caption">Версия текста от {MEMORY_CONSENT.version}</p>}
        {error && (
          <p className="rd-form-error" data-testid="form-error">
            {error}
          </p>
        )}
        {consent ? (
          <>
            <Button
              fill
              large
              preloader
              loading={busy}
              disabled={busy}
              onClick={onAccept}
              data-testid="memory-consent-accept"
            >
              {MEMORY_CONSENT.accept}
            </Button>
            <Button large disabled={busy} onClick={onClose} data-testid="memory-consent-decline">
              {MEMORY_CONSENT.decline}
            </Button>
          </>
        ) : (
          <Button fill large onClick={onClose}>
            Понятно
          </Button>
        )}
      </div>
    </Sheet>
  )
}
