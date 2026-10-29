import {
  CHART_WINDOW_DAYS,
  MOOD_LABELS,
  buildRollingChart,
  mostFrequentMood,
  moodColor,
  moodInsight,
  plural,
} from '@ryadom/client-core/diary'
import type { DiaryApiResponse } from '@ryadom/contracts/api/diary'
import { MoodFaceShape } from './MoodFace'

const WIDTH = 320
const HEIGHT = 168
const PAD_X = 30
const PAD_Y = 18
const LABELS_HEIGHT = 36

/**
 * «Динамика настроения»: the last 28 days as an own SVG (no chart library). The window starts at the first
 * note (seven columns at least), the line is a smooth curve with an area under it, a day without a note
 * does not break it, weekends are shaded and today's point is a hollow ring.
 */
export default function MoodChart({ data, today }: { data: DiaryApiResponse; today: string }) {
  const chart = buildRollingChart(data.recent, today, { width: WIDTH, height: HEIGHT, padX: PAD_X, padY: PAD_Y })
  const empty = chart.points.length === 0
  const top = chart.moodY(5)
  const bottom = chart.moodY(1)
  const most = mostFrequentMood(chart.points)
  const alt = empty
    ? ''
    : `За последние ${CHART_WINDOW_DAYS} дней отмечено ${chart.points.length} ${plural(chart.points.length, 'день', 'дня', 'дней')}, чаще всего — ${MOOD_LABELS[most ?? 3].toLowerCase()}`
  const insight = moodInsight(chart.points.map((p) => ({ mood: p.mood, factor: data.recent.find((d) => d.date === p.date)?.factor ?? null })))

  return (
    <section className="rd-card rd-chart-card" data-testid="diary-chart-card" aria-labelledby="diary-chart-title">
      <div className="rd-chart-head">
        <h2 className="rd-card-title" id="diary-chart-title">
          Динамика настроения
        </h2>
        {!empty && (
          <span className="rd-chart-month-name" data-testid="diary-chart-month">
            {chart.header}
          </span>
        )}
      </div>

      {empty ? (
        <p className="rd-muted rd-chart-empty" data-testid="diary-chart-empty">
          Отмечай настроение каждый день — здесь появится график
        </p>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT + LABELS_HEIGHT}`}
            className="rd-chart"
            role="img"
            aria-label={alt}
            data-testid="diary-chart"
            data-points={chart.points.length}
            data-slots={chart.slots}
          >
            {chart.columns
              .filter((column) => column.weekend)
              .map((column) => (
                <rect
                  key={column.slot}
                  x={column.x}
                  y={top - 10}
                  width={column.width}
                  height={bottom - top + 20}
                  className="rd-chart-weekend"
                  data-testid="diary-chart-weekend"
                />
              ))}
            {[5, 4, 3, 2, 1].map((level) => (
              <line key={level} x1={PAD_X - 6} x2={WIDTH - 8} y1={chart.moodY(level as 1)} y2={chart.moodY(level as 1)} className="rd-chart-grid" />
            ))}
            {chart.faces.map((face) => (
              <g key={face.mood} transform={`translate(${2} ${face.y - 9}) scale(${18 / 48})`}>
                <MoodFaceShape level={face.mood} />
              </g>
            ))}
            {chart.areaPath && <path d={chart.areaPath} className="rd-chart-area" />}
            {chart.linePath && <path d={chart.linePath} className="rd-chart-line" />}
            {chart.points.map((point) =>
              point.isToday ? (
                <circle
                  key={point.date}
                  cx={point.x}
                  cy={point.y}
                  r={6}
                  fill="none"
                  stroke={moodColor(point.mood)}
                  strokeWidth={2}
                  data-testid="diary-chart-point"
                  data-date={point.date}
                  data-mood={point.mood}
                  data-today="true"
                />
              ) : (
                <circle
                  key={point.date}
                  cx={point.x}
                  cy={point.y}
                  r={4}
                  fill={moodColor(point.mood)}
                  className="rd-chart-dot"
                  data-testid="diary-chart-point"
                  data-date={point.date}
                  data-mood={point.mood}
                />
              ),
            )}
            {chart.labels.map((label) => {
              const cx = label.x + 0
              return (
                <g key={label.slot} data-testid="diary-chart-label">
                  <text x={cx} y={HEIGHT + 8} className="rd-chart-tick" textAnchor="middle">
                    {label.letter}
                  </text>
                  {label.isToday && <circle cx={cx} cy={HEIGHT + 24} r={9} className="rd-chart-today" data-testid="diary-chart-today" />}
                  {label.showDay && (
                    <text
                      x={cx}
                      y={HEIGHT + 27}
                      className={label.isToday ? 'rd-chart-today-text' : 'rd-chart-tick'}
                      textAnchor="middle"
                    >
                      {label.day}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
          {insight && (
            <p className="rd-chart-insight" data-testid="diary-insight">
              <span aria-hidden="true">💡 </span>
              {insight}
            </p>
          )}
        </>
      )}
    </section>
  )
}
