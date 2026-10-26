import { Button } from 'framework7-react'
import type { Router } from 'framework7/types'
import type { DiarySummaryApi } from '@ryadom/contracts/api/diary'

/**
 * «Итоги прошлой недели»: the final summary of the last finished week. Older weeks are not kept on
 * screen; this card goes when the week has no final summary (too few marked days). After a heavy week
 * (three or more days of «Тяжело», counted by the server) «Люди рядом» is offered, as under this week's text.
 */
export default function PreviousWeekCard({ summary, f7router }: { summary: DiarySummaryApi; f7router: Router.Router }) {
  return (
    <section className="rd-card" data-testid="diary-previous-week" aria-labelledby="diary-previous-week-title">
      <h2 className="rd-card-title" id="diary-previous-week-title">
        Итоги прошлой недели
      </h2>
      <p className="rd-summary-text">{summary.text}</p>
      {summary.hardDays >= 3 && (
        <Button small round outline data-testid="diary-previous-week-people" onClick={() => f7router.navigate('/people/')}>
          Люди рядом
        </Button>
      )}
    </section>
  )
}
