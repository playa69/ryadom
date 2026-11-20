import { Button, Icon } from 'framework7-react'
import { useLayoutEffect, useRef, useState } from 'react'
import {
  canShareRecommendation,
  RECOMMENDATION_COPY,
  RECOMMENDATION_TEXT,
  RECOMMENDATION_URL,
} from '@ryadom/client-core/dialog-recommendation'

export default function RecommendationCard({
  onClose,
  onCopy,
  onShare,
  revealInFeed,
}: {
  onClose(): void
  onCopy(): void
  onShare(): void
  revealInFeed: boolean
}) {
  const [status, setStatus] = useState('')
  const card = useRef<HTMLElement>(null)

  useLayoutEffect(() => {
    if (revealInFeed) card.current?.scrollIntoView({ block: 'nearest' })
  }, [revealInFeed])

  async function copy() {
    try {
      await navigator.clipboard.writeText(RECOMMENDATION_COPY)
      setStatus('Текст скопирован')
      onCopy()
    } catch {
      setStatus('Выдели текст и скопируй вручную')
    }
  }

  function share() {
    onShare()
    void navigator.share({ text: RECOMMENDATION_TEXT, url: RECOMMENDATION_URL }).catch(() => {})
  }

  return (
    <section
      ref={card}
      className="rd-card rd-recommendation"
      aria-label="Порекомендовать Рядом"
      data-testid="dialog-recommendation"
    >
      <h2>Порекомендовать Рядом</h2>
      <button
        type="button"
        className="rd-recommendation-close"
        aria-label="Закрыть рекомендацию"
        onClick={onClose}
      >
        <Icon f7="xmark" size={15} aria-hidden="true" />
      </button>
      <p className="rd-recommendation-copy">
        {RECOMMENDATION_TEXT}{' '}
        <a href={RECOMMENDATION_URL} className="external">
          слышу-рядом.рф
        </a>
      </p>
      <div className="rd-recommendation-actions">
        <Button type="button" fill round onClick={() => void copy()}>
          Скопировать текст
        </Button>
        {canShareRecommendation() && (
          <Button type="button" outline round aria-label="Поделиться рекомендацией" onClick={share}>
            Поделиться
          </Button>
        )}
      </div>
      <p className="rd-recommendation-status" role="status">
        {status}
      </p>
    </section>
  )
}
