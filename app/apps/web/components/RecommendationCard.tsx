import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  canShareRecommendation,
  RECOMMENDATION_COPY,
  RECOMMENDATION_TEXT,
  RECOMMENDATION_URL,
} from '@ryadom/client-core/dialog-recommendation'
import { Button } from '@ryadom/ui/components/button'
import { BUTTON } from './controls'

export default function RecommendationCard({
  onClose,
  onCopy,
  onShare,
}: {
  onClose(): void
  onCopy(): void
  onShare(): void
}) {
  const [status, setStatus] = useState('')
  const [canShare, setCanShare] = useState(false)
  useEffect(() => setCanShare(canShareRecommendation()), [])

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
      aria-label="Порекомендовать Рядом"
      data-testid="dialog-recommendation"
      className="glass relative w-full max-w-[31.25rem] shrink-0 rounded-[20px] p-3.5"
    >
      <h2 className="pr-11 text-base font-semibold">Порекомендовать Рядом</h2>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Закрыть рекомендацию"
        className={`${BUTTON} absolute top-0.5 right-0.5 size-11 text-dim`}
        onClick={onClose}
      >
        <X aria-hidden="true" className="size-4" />
      </Button>
      <p className="mt-1 text-sm leading-snug text-dim select-text">
        {RECOMMENDATION_TEXT}{' '}
        <a href={RECOMMENDATION_URL} className="whitespace-nowrap text-brand-400 hover:underline">
          слышу-рядом.рф
        </a>
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button type="button" size="sm" className={`${BUTTON} min-h-11 px-4`} onClick={() => void copy()}>
          Скопировать текст
        </Button>
        {canShare && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={`${BUTTON} min-h-11 border-input! px-4`}
            aria-label="Поделиться рекомендацией"
            onClick={share}
          >
            Поделиться
          </Button>
        )}
      </div>
      <p role="status" className={status ? 'mt-2 text-sm text-dim' : 'sr-only'}>
        {status}
      </p>
    </section>
  )
}
