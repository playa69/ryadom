import type { DiarySummaryApi } from '@ryadom/contracts/api/diary'

/**
 * «Итоги прошлой недели»: the final summary of the last finished week, text only. Older weeks are not
 * kept on screen; this card goes when the week has no final summary (too few marked days).
 */
export default function PreviousWeekCard({ summary }: { summary: DiarySummaryApi }) {
  return (
    <section className="rd-card" data-testid="diary-previous-week" aria-labelledby="diary-previous-week-title">
      <h2 className="rd-card-title" id="diary-previous-week-title">
        Итоги прошлой недели
      </h2>
      <p className="rd-summary-text">{summary.text}</p>
    </section>
  )
}
