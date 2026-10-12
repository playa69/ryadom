import { Button, Sheet } from 'framework7-react'

/**
 * Pressing "talk" found a conversation the person left unfinished (with something said in it). They
 * decide: go on with it, or end it and begin a new one. Closing the sheet (the button, a swipe or a
 * tap outside) changes nothing.
 */
export default function ResumeDialogSheet({
  opened,
  busy,
  onContinue,
  onStartNew,
  onClose,
}: {
  opened: boolean
  /** "End it and begin a new one" is in flight: one press is enough. */
  busy: boolean
  onContinue: () => void
  onStartNew: () => void
  /** Called by the button and by the sheet itself when it closes, whoever closed it. */
  onClose: () => void
}) {
  return (
    <Sheet
      opened={opened}
      onSheetClosed={onClose}
      swipeToClose
      closeOnEscape
      backdrop
      style={{ height: 'auto' }}
    >
      <div className="rd-sheet-body" data-testid="resume-sheet">
        <h2 className="rd-sheet-title">Есть незавершённый разговор</h2>
        <p className="rd-muted">Продолжить его или завершить и начать новый?</p>

        <Button fill large disabled={busy} onClick={onContinue} data-testid="resume-continue">
          Продолжить
        </Button>
        <Button
          large
          outline
          preloader
          loading={busy}
          disabled={busy}
          onClick={onStartNew}
          data-testid="resume-new"
        >
          Завершить и начать новый
        </Button>
        <Button large disabled={busy} onClick={onClose} data-testid="resume-close">
          Закрыть
        </Button>
      </div>
    </Sheet>
  )
}
