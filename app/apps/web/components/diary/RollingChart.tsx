'use client'

import { Lightbulb } from 'lucide-react'
import { useMemo } from 'react'
import {
  MOOD_LABELS,
  buildRollingChart,
  mostFrequentMood,
  moodColor,
  plural,
} from '@ryadom/client-core/diary'
import type { MoodCheckinApi, MoodLevel } from '@ryadom/contracts/api/diary'
import { Card } from '@ryadom/ui/components/card'
import { MoodFace } from './MoodFace'

const W = 340
const H = 150
/** Room under the plot for the weekday letters and the day numbers. */
const AXIS = 34

/**
 * "Динамика настроения": the last 28 days up to today, not a calendar month. A smooth curve with an
 * area under it through the marked days (a day without a note does not break it), the day of today as
 * a hollow ring, Saturday and Sunday shaded, a weekday letter and the day number under each column.
 * Own SVG, no chart library; the picture has a text alternative for a screen reader.
 */
export default function RollingChart({
  recent,
  today,
  insight,
}: {
  recent: readonly MoodCheckinApi[]
  today: string
  insight: string | null
}) {
  const chart = useMemo(
    () => buildRollingChart(recent, today, { width: W, height: H, padX: 16, padY: 16 }),
    [recent, today],
  )
  const empty = recent.length === 0
  const top = mostFrequentMood(recent)
  const alt = empty
    ? 'Отметок пока нет'
    : `За последние дни отмечено ${recent.length} ${plural(recent.length, 'день', 'дня', 'дней')}, чаще всего — ${MOOD_LABELS[top ?? 3].toLowerCase()}`

  return (
    <Card className="gap-4 rounded-lg px-5 py-5 shadow-none" data-testid="diary-chart-card">
      <div className="flex flex-col items-start gap-0.5 sm:flex-row sm:items-center sm:gap-2">
        <h2 className="min-w-0 flex-1 text-lg font-semibold text-foreground">Динамика настроения</h2>
        {!empty && (
          <span className="text-sm font-medium whitespace-nowrap text-dim" data-testid="diary-chart-month">
            {chart.header}
          </span>
        )}
      </div>

      {empty ? (
        <p
          className="py-6 text-center text-[0.9375rem] leading-snug text-dim"
          data-testid="diary-chart-empty"
        >
          Отмечай настроение каждый день — здесь появится график
        </p>
      ) : (
        <div className="relative" data-testid="diary-chart">
          <div className="pointer-events-none absolute inset-y-0 left-0 w-[18px]" aria-hidden="true">
            {chart.faces.map((face) => (
              <span
                key={face.mood}
                className="absolute left-0 -translate-y-1/2"
                style={{ top: `${(face.y / (H + AXIS)) * 100}%` }}
              >
                <MoodFace mood={face.mood as MoodLevel} size={18} />
              </span>
            ))}
          </div>
          <svg
            viewBox={`0 0 ${W} ${H + AXIS}`}
            role="img"
            aria-label={alt}
            className="ml-6 h-auto w-[calc(100%-1.5rem)]"
          >
            <title>{alt}</title>
            <defs>
              <linearGradient id="diary-area" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="rgba(96,128,255,0.35)" />
                <stop offset="1" stopColor="rgba(96,128,255,0.04)" />
              </linearGradient>
            </defs>
            {chart.columns.map((column) =>
              column.weekend || column.future ? (
                <rect
                  key={column.slot}
                  data-testid={column.weekend ? 'diary-chart-weekend' : 'diary-chart-future'}
                  x={column.x}
                  y={0}
                  width={column.width}
                  height={H}
                  rx={3}
                  fill={column.weekend ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.03)'}
                />
              ) : null,
            )}
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
            {chart.areaPath && <path d={chart.areaPath} fill="url(#diary-area)" />}
            {chart.linePath && (
              <path
                d={chart.linePath}
                fill="none"
                stroke="rgba(120,150,255,0.95)"
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}
            {chart.points.map((p) => (
              <circle
                key={p.date}
                data-testid="diary-chart-point"
                data-date={p.date}
                data-mood={p.mood}
                cx={p.x}
                cy={p.y}
                r={p.isToday ? 6 : 4.5}
                fill={p.isToday ? 'none' : moodColor(p.mood)}
                stroke={p.isToday ? moodColor(p.mood) : '#0c1438'}
                strokeWidth={p.isToday ? 2 : 1.5}
              >
                <title>{`${p.date}: ${MOOD_LABELS[p.mood].toLowerCase()}`}</title>
              </circle>
            ))}
            {chart.labels.map((label) => (
              <g key={label.slot} data-testid={label.isToday ? 'diary-chart-today' : undefined}>
                <text
                  x={label.x}
                  y={H + 12}
                  textAnchor="middle"
                  fontSize="9"
                  fontWeight="600"
                  fill="rgba(184,194,217,0.9)"
                >
                  {label.letter}
                </text>
                {label.isToday && <circle cx={label.x} cy={H + 25} r={9} fill="rgba(0,122,255,0.55)" />}
                {(label.showDay || label.isToday) && (
                  <text
                    x={label.x}
                    y={H + 28.5}
                    textAnchor="middle"
                    fontSize="10"
                    fontWeight={label.isToday ? 700 : 500}
                    fill="#fff"
                  >
                    {label.day}
                  </text>
                )}
              </g>
            ))}
          </svg>
        </div>
      )}

      {insight && (
        <p
          className="flex items-start gap-2 rounded-lg bg-white/5 px-3 py-2.5 text-[0.9375rem] leading-snug text-foreground"
          data-testid="diary-insight"
        >
          <Lightbulb aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-brand-400" />
          <span>{insight}</span>
        </p>
      )}
    </Card>
  )
}
