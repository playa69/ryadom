import { Icon } from 'framework7-react'
import {
  MOOD_LEVELS,
  buildChart,
  chartAlt,
  daysInMonth,
  monthName,
  moodColor,
  parseDate,
  toMonthKey,
} from '@ryadom/client-core/diary'
import type { DiaryApiResponse } from '@ryadom/contracts/api/diary'
import { MoodFaceShape } from './MoodFace'

const WIDTH = 320
const HEIGHT = 168
const PAD_X = 30
const PAD_Y = 18
/** How far back the arrows go: a diary of a few years is far from a reason for a library. */
const MAX_MONTHS_BACK = 24

function shiftMonth(month: string, delta: number): string {
  const [y = 0, m = 1] = month.split('-').map(Number)
  const index = y * 12 + (m - 1) + delta
  return toMonthKey(Math.floor(index / 12), (index % 12) + 1)
}

/**
 * «Динамика настроения»: the month as an own SVG (no chart library). Days along x, the five levels along
 * y; a gap in the days breaks the line, days after today are shaded, today is a numbered circle.
 */
export default function MoodChart({
  data,
  month,
  today,
  onMonth,
}: {
  data: DiaryApiResponse
  month: string
  today: string
  onMonth: (month: string) => void
}) {
  const { year, month: m } = parseDate(`${month}-01`)
  const current = today.slice(0, 7)
  const isCurrent = month === current
  const chart = buildChart(year, m, data.month, { width: WIDTH, height: HEIGHT, padX: PAD_X, padY: PAD_Y })
  const todayDay = isCurrent ? parseDate(today).day : null
  const count = daysInMonth(year, m)
  const empty = isCurrent && data.month.length === 0
  const oldest = shiftMonth(current, -MAX_MONTHS_BACK)
  const ticks = [1, 5, 10, 15, 20, 25, count].filter((d, i, all) => all.indexOf(d) === i && d <= count)

  return (
    <section className="rd-card rd-chart-card" data-testid="diary-chart-card" aria-labelledby="diary-chart-title">
      <div className="rd-chart-head">
        <h2 className="rd-card-title" id="diary-chart-title">
          Динамика настроения
        </h2>
        <div className="rd-chart-month">
          <button
            type="button"
            className="rd-chart-arrow"
            aria-label="Предыдущий месяц"
            disabled={month <= oldest}
            data-testid="diary-chart-prev"
            onClick={() => onMonth(shiftMonth(month, -1))}
          >
            <Icon f7="chevron_left" size={16} />
          </button>
          <span className="rd-chart-month-name" data-testid="diary-chart-month">
            {monthName(m)}
          </span>
          <button
            type="button"
            className="rd-chart-arrow"
            aria-label="Следующий месяц"
            disabled={isCurrent}
            data-testid="diary-chart-next"
            onClick={() => onMonth(shiftMonth(month, 1))}
          >
            <Icon f7="chevron_right" size={16} />
          </button>
        </div>
      </div>

      {empty ? (
        <p className="rd-muted rd-chart-empty" data-testid="diary-chart-empty">
          Отмечай настроение каждый день — здесь появится график
        </p>
      ) : (
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT + 22}`}
          className="rd-chart"
          role="img"
          aria-label={chartAlt(year, m, data.month)}
          data-testid="diary-chart"
          data-points={chart.points.length}
        >
          {MOOD_LEVELS.map((level) => (
            <line
              key={level}
              x1={PAD_X - 6}
              x2={WIDTH - 8}
              y1={chart.moodY(level)}
              y2={chart.moodY(level)}
              className="rd-chart-grid"
            />
          ))}
          {[5, 3, 1].map((level) => (
            <g
              key={level}
              transform={`translate(${2} ${chart.moodY(level as 1 | 3 | 5) - 9}) scale(${18 / 48})`}
            >
              <MoodFaceShape level={level as 1 | 3 | 5} />
            </g>
          ))}
          {todayDay !== null && todayDay < count && (
            <rect
              x={chart.dayX(todayDay) + 4}
              y={PAD_Y - 8}
              width={Math.max(chart.dayX(count) + 6 - (chart.dayX(todayDay) + 4), 0)}
              height={HEIGHT - 2 * PAD_Y + 16}
              className="rd-chart-future"
              data-testid="diary-chart-future"
            />
          )}
          {chart.segments
            .filter((segment) => segment.length > 1)
            .map((segment) => (
              <polyline
                key={segment[0]!.day}
                points={segment.map((p) => `${p.x},${p.y}`).join(' ')}
                className="rd-chart-line"
              />
            ))}
          {chart.points.map((point) => (
            <circle
              key={point.day}
              cx={point.x}
              cy={point.y}
              r={5}
              fill={moodColor(point.mood)}
              className="rd-chart-dot"
              data-testid="diary-chart-point"
              data-day={point.day}
              data-mood={point.mood}
            />
          ))}
          {ticks.map((day) =>
            day === todayDay ? null : (
              <text key={day} x={chart.dayX(day)} y={HEIGHT + 12} className="rd-chart-tick" textAnchor="middle">
                {day}
              </text>
            ),
          )}
          {todayDay !== null && (
            <g data-testid="diary-chart-today">
              <circle cx={chart.dayX(todayDay)} cy={HEIGHT + 8} r={9} className="rd-chart-today" />
              <text x={chart.dayX(todayDay)} y={HEIGHT + 12} className="rd-chart-today-text" textAnchor="middle">
                {todayDay}
              </text>
            </g>
          )}
        </svg>
      )}
    </section>
  )
}
