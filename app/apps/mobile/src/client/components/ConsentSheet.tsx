import { useEffect } from 'react'
import { Button, Sheet } from 'framework7-react'
import { DataConsentCheckbox } from './ConsentNote'

/**
 * The consent sheet of the PWA/Telegram home (`openspec/changes/add-fast-dialog-start`, «Согласие при
 * первом действии»): the first text or voice start with no current consent on record opens it over
 * home instead of sending anything. The content is the one the entry gate had: the mandatory tick —
 * unchecked by default, so «Продолжить» stays disabled until it is given — with the links to the
 * terms and the data consent. Closing (the button, a swipe, Esc or a tap on the backdrop) sends
 * nothing and keeps the draft and the start intention on home; while the chain after «Продолжить»
 * is in flight, none of them closes it. The native shell never shows it: the
 * consent gate on the first screen is kept there.
 */
export default function ConsentSheet({
  opened,
  busy,
  checked,
  onCheckedChange,
  onContinue,
  onClose,
}: {
  opened: boolean
  /** The chain after «Продолжить» is in flight: one press is enough, and closing waits for it. */
  busy: boolean
  /** The mandatory tick, owned by the page so a close and a document link do not untick it. */
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  onContinue: () => void
  /** The close button and the sheet itself, whoever closed it. */
  onClose: () => void
}) {
  useEffect(() => {
    if (!opened || busy) return
    // After the voice sheet is shown, the Framework7 backdrop handler no longer reaches this
    // controlled sheet even with closeByBackdropClick on, so a backdrop tap would close the DOM
    // sheet while `opened` stays true. Catch the tap directly and report it through onClose.
    const onBackdropClick = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.classList.contains('sheet-backdrop')) {
        onClose()
      }
    }
    document.addEventListener('click', onBackdropClick)
    return () => document.removeEventListener('click', onBackdropClick)
  }, [opened, busy, onClose])

  return (
    <Sheet
      opened={opened}
      onSheetClosed={onClose}
      swipeToClose={!busy}
      closeOnEscape={!busy}
      // The default would close on a backdrop tap even while the chain is in flight, leaving the
      // controlled `opened` prop true against an already closed sheet.
      closeByBackdropClick={!busy}
      backdrop
      style={{ height: 'auto' }}
    >
      <div className="rd-sheet-body" data-testid="consent-sheet">
        <h2 className="rd-sheet-title">Перед началом</h2>
        <p className="rd-muted">Один раз подтверди, что согласен(на), — и можно говорить.</p>
        <DataConsentCheckbox checked={checked} onChange={onCheckedChange} />
        <Button
          fill
          large
          preloader
          loading={busy}
          disabled={busy || !checked}
          onClick={onContinue}
          data-testid="consent-continue"
        >
          Продолжить
        </Button>
        <Button large disabled={busy} onClick={onClose} data-testid="consent-close">
          Закрыть
        </Button>
      </div>
    </Sheet>
  )
}
