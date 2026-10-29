import { Button, Sheet } from 'framework7-react'
import { MEMORY_INVITE } from '@ryadom/client-core/memory'

/**
 * The sheet "Рядом теперь запоминает важное", shown once on home to a person who has not decided about
 * memory. Nothing is chosen for them: "Включить" leads to the consent sheet, "Не сейчас" (or any other
 * way of closing it) leaves memory off. The sheet comes from home; the answer is handled there.
 */
export default function MemoryInviteSheet({
  opened,
  onAccept,
  onDecline,
}: {
  opened: boolean
  onAccept: () => void
  /** The button, a swipe or a tap outside. */
  onDecline: () => void
}) {
  return (
    <Sheet opened={opened} onSheetClosed={onDecline} backdrop style={{ height: 'auto' }}>
      <div className="rd-sheet-body rd-sheet-scroll" data-testid="memory-invite">
        <h2 className="rd-sheet-title">{MEMORY_INVITE.title}</h2>
        {MEMORY_INVITE.paragraphs.map((text) => (
          <p key={text} className="rd-muted rd-memory-paragraph">
            {text}
          </p>
        ))}
        <Button fill large onClick={onAccept} data-testid="memory-invite-accept">
          {MEMORY_INVITE.accept}
        </Button>
        <Button large onClick={onDecline} data-testid="memory-invite-decline">
          {MEMORY_INVITE.decline}
        </Button>
      </div>
    </Sheet>
  )
}
