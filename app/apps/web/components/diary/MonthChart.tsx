'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useMemo } from 'react'
import {
  MOOD_LABELS,
  buildChart,
  chartAlt,
  daysInMonth,
  moodColor,
  monthName,
  parseDate,
} from '@ryadom/client-core/diary'
import type { MoodCheckinApi, MoodLevel } from '@ryadom/contracts/api/diary'
import { Button } from '@ryadom/ui/components/button'
import { Card } from '@ryadom/ui/components/card'
import { BUTTON } from '../controls'
import { MoodFace } from './MoodFace'

const W = 340
const H = 150

/**
 * "Динамика настроения": days along x, five levels along y, own SVG (no chart library). A missing day
 * breaks the line, today is circled with its number, the days still to come are shaded. The picture has
 * a text alternative for a screen reader.
 */
export default function MonthChart({
  year,
  month,
  days,
  today,
  loading,
  onPrev,
  onNext,
}: {
  year: number
  month: number
  days: readonly MoodCheckinApi[]
  /** `YYYY-MM-DD` of today on this device. */
  today: string
  loading: boolean
  onPrev(): void
  /** Absent while the current month is shown. */
  onNext?: () => void
}) {
  const chart = useMemo(() => buildChart(year, month, days, { width: W, height: H, padX: 16, padY: 16 }), [year, month, days])
  const t = parseDate(today)
  const isCurrent = t.year === year && t.month === month
  const total = daysInMonth(year, month)
  const empty = days.length === 0
  const alt = chartAlt(year, month, days)
  const futureFrom = isCurrent ? t.day + 1 : t.year * 12 + t.month < year * 12 + month ? 1 : total + 1

  return (
    <Card className="gap-4 rounded-lg px-5 py-5 shadow-none" data-testid="diary-chart-card">
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 text-lg font-semibold text-foreground">Динамика настроения</h2>
        <Button variant="ghost" size="icon" className={BUTTON} aria-label="Предыдущий месяц" data-testid="diary-chart-prev" onClick={onPrev}>
          <ChevronLeft />
        </Button>
        <span className="min-w-24 text-center text-sm font-medium text-dim capitalize" data-testid="diary-chart-month">
          {monthName(month)} {year !== t.year ? year : ''}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className={BUTTON}
          aria-label="Следующий месяц"
          data-testid="diary-chart-next"
          disabled={!onNext}
          onClick={onNext}
        >
          <ChevronRight />
        </Button>
      </div>

      {empty && !loading ? (
        <p className="py-6 text-center text-[0.9375rem] leading-snug text-dim" data-testid="diary-chart-empty">
          Отмечай настроение каждый день — здесь появится график
        </p>
      ) : (
        <div className="flex gap-2" data-testid="diary-chart" aria-busy={loading}>
          <div className="flex shrink-0 flex-col justify-between py-1" aria-hidden="true">
            {([5, 3, 1] as MoodLevel[]).map((level) => (
              <MoodFace key={level} mood={level} size={18} />
            ))}
          </div>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={alt} className="h-auto min-w-0 flex-1">
            <title>{alt}</title>
            {[1, 2, 3, 4, 5].map((level) => (
              <line
                key={level}
                x1={0}
                x2={W}
                y1={chart.moodY(level as MoodLevel)}
                y2={chart.moodY(level as MoodLevel)}
                stroke="rgba(255,255,255,0.08)"
                strokeWidth="1"
              />
            ))}
            {futureFrom <= total && (
              <rect
                data-testid="diary-chart-future"
                x={chart.dayX(futureFrom) - 4}
                y={0}
                width={W - chart.dayX(futureFrom) + 4}
                height={H}
                fill="rgba(255,255,255,0.05)"
              />
            )}
            {chart.segments.map((segment, i) =>
              segment.length > 1 ? (
                <polyline
                  key={i}
                  points={segment.map((p) => `${p.x},${p.y}`).join(' ')}
                  fill="none"
                  stroke="rgba(184,194,217,0.7)"
                  strokeWidth="2"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ) : null,
            )}
            {chart.points.map((p) => (
              <circle
                key={p.day}
                data-testid="diary-chart-point"
                data-day={p.day}
                data-mood={p.mood}
                cx={p.x}
                cy={p.y}
                r={5}
                fill={moodColor(p.mood)}
              >
                <title>{`${p.day}: ${MOOD_LABELS[p.mood].toLowerCase()}`}</title>
              </circle>
            ))}
            {isCurrent && (
              <g data-testid="diary-chart-today">
                <circle cx={chart.dayX(t.day)} cy={H - 4} r={9} fill="rgba(0,122,255,0.35)" />
                <text x={chart.dayX(t.day)} y={H - 0.5} textAnchor="middle" fontSize="10" fontWeight="600" fill="#fff">
                  {t.day}
                </text>
              </g>
            )}
          </svg>
        </div>
      )}
    </Card>
  )
}
