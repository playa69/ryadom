import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { Button, Icon, f7 } from 'framework7-react'
import { useState } from 'react'
import {
  MEMORY_FACT_ERRORS,
  MEMORY_FORGET_ERRORS,
  memoryFactChange,
  type MemoryCardItem,
} from '@ryadom/client-core/memory'
import { apiErrorText, codeText, forgetMemoryFact, updateMemoryFact } from '../../../lib/api'
import { memoryCard, pendingForgets, useMemoryCard, usePendingForgets } from '../../../lib/memory'
import { openRoute } from '../../../lib/nav'

/**
 * "Я запомнил": after a conversation with memory, what it added, two to four points, each with
 * "убрать" (and "Запомнить" for one that waits for the person's answer). It appears on home once the
 * agent has finished, and only if there is something to show: nothing is said when there is not.
 * The texts are the person's words: the card carries `ph-no-capture`, and only the kind of tap is reported.
 */
export default function MemoryCard({ owner }: { owner: string | null }) {
  const card = useMemoryCard(owner)
  const pending = usePendingForgets()
  const [busyId, setBusyId] = useState<string | null>(null)
  if (!card) return null

  const toast = (text: string) => f7.toast.create({ text, closeTimeout: 2500 }).open()

  /** "убрать": the same five seconds to take it back as on the screen "Память". */
  function dismiss(item: MemoryCardItem) {
    const { id } = item.fact
    pendingForgets.schedule(id, async () => {
      try {
        const result = await forgetMemoryFact(id)
        if (!result.ok) {
          toast(codeText(MEMORY_FORGET_ERRORS, result.code, 'Не получилось убрать'))
          return
        }
        track(AnalyticsEvent.MemoryCardAction, { action: 'dismiss_item' })
        memoryCard.remove(id)
      } catch (error) {
        toast(apiErrorText(error, {}, 'Не получилось убрать'))
      }
    })
  }

  async function accept(item: MemoryCardItem) {
    setBusyId(item.fact.id)
    try {
      const result = await updateMemoryFact(item.fact.id, memoryFactChange('accept'))
      if (!result.ok) {
        toast(codeText(MEMORY_FACT_ERRORS, result.code, 'Не получилось'))
        return
      }
      track(AnalyticsEvent.MemoryCardAction, { action: 'accept_item' })
      memoryCard.update(result.data)
    } catch (error) {
      toast(apiErrorText(error, {}, 'Не получилось'))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="rd-card rd-memory-card ph-no-capture" data-testid="memory-card" role="status">
      <div className="rd-memory-card-head">
        <Icon f7="sparkles" size={20} className="rd-note-icon" />
        <p className="rd-note-title">Я запомнил</p>
        <button
          type="button"
          className="rd-memory-card-close"
          aria-label="Закрыть"
          onClick={() => memoryCard.close()}
          data-testid="memory-card-close"
        >
          <Icon f7="xmark" size={16} />
        </button>
      </div>
      <ul className="rd-memory-card-items">
        {card.items.map((item) =>
          pending.has(item.fact.id) ? (
            <li key={item.fact.id} className="rd-memory-card-item rd-memory-undo" data-testid="memory-undo">
              <span className="rd-caption">Убрал.</span>
              <Button
                small
                round
                onClick={() => pendingForgets.undo(item.fact.id)}
                data-testid="memory-undo-button"
              >
                Вернуть
              </Button>
            </li>
          ) : (
            <li key={item.fact.id} className="rd-memory-card-item" data-testid="memory-card-item">
              <span className="rd-memory-card-text">{item.fact.text}</span>
              <span className="rd-memory-card-actions">
                {item.proposed && (
                  <Button
                    small
                    round
                    fill
                    disabled={busyId === item.fact.id}
                    onClick={() => void accept(item)}
                    data-testid="memory-card-accept"
                  >
                    Запомнить
                  </Button>
                )}
                <Button small round outline onClick={() => dismiss(item)} data-testid="memory-card-dismiss">
                  убрать
                </Button>
              </span>
            </li>
          ),
        )}
      </ul>
      {card.more > 0 && <p className="rd-caption">И ещё {card.more} — в «Профиль → Память».</p>}
      <Button
        small
        className="rd-memory-card-link"
        data-testid="memory-card-link"
        onClick={() => {
          // The whole list is where the person is going: the card has done its job.
          memoryCard.close()
          openRoute('/profile/memory/')
        }}
      >
        Всё, что я помню
      </Button>
    </div>
  )
}
