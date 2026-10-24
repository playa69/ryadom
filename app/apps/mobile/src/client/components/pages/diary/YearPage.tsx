import { Block, Button, Icon, Preloader } from 'framework7-react'
import type { Router } from 'framework7/types'
import { useCallback, useEffect, useState } from 'react'
import {
  MOOD_LABELS,
  MOOD_LEVELS,
  buildYearGrid,
  dayCaption,
  longDate,
  moodColor,
  monthName,
} from '@ryadom/client-core/diary'
import { YEAR_STORY_EXTEND_WEEKS, YEAR_STORY_MIN_WEEKS, type DiaryYearApiResponse } from '@ryadom/contracts/api/diary'
import { apiErrorText, createYearStory } from '../../../lib/api'
import { loadDiaryYear } from '../../../lib/diary'
import { deviceDate } from '../../../lib/diary-queue'
import { shareYearImage } from '../../../lib/year-image'
import DiaryShell from './DiaryShell'

/** How many years back the arrows go. */
const YEARS_BACK = 2
const DAY_TICKS = [1, 5, 10, 15, 20, 25, 31]

/**
 * Segment «Год»: «Год в пикселях» (12 rows of months by 31 days, no 31 February), the legend, the two
 * plaques, the picture to share and «Итоги года».
 */
export default function YearPage({ f7router }: { f7router: Router.Router }) {
  const today = deviceDate()
  const thisYear = Number(today.slice(0, 4))
  const [year, setYear] = useState(thisYear)
  const [data, setData] = useState<DiaryYearApiResponse | null>(null)
  const [error, setError] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [shareNote, setShareNote] = useState('')
  const [storyBusy, setStoryBusy] = useState(false)
  const [storyError, setStoryError] = useState('')

  const load = useCallback(() => {
    let cancelled = false
    setData(null)
    setError('')
    setPicked(null)
    loadDiaryYear(year)
      .then((result) => !cancelled && setData(result))
      .catch((e: unknown) => !cancelled && setError(apiErrorText(e, {}, 'Не получилось загрузить год')))
    return () => {
      cancelled = true
    }
  }, [year])

  useEffect(() => load(), [load])

  const grid = data ? buildYearGrid(year, data.days, today) : buildYearGrid(year, [], today)
  const pickedEntry = data?.days.find((d) => d.date === picked) ?? null

  async function share() {
    if (!data) return
    const result = await shareYearImage(year, data.days, today)
    setShareNote(
      result === 'downloaded' ? `Картинка сохранена: ryadom-${year}.png` : result === 'failed' ? 'Не получилось поделиться' : '',
    )
  }

  async function buildStory() {
    setStoryBusy(true)
    setStoryError('')
    try {
      const outcome = await createYearStory({ year })
      if (!outcome.ok) setStoryError('Пока нечего дописывать. Загляни, когда накопятся новые итоги недель')
      else load()
    } catch {
      setStoryError('Не получилось собрать историю. Попробуй позже')
    } finally {
      setStoryBusy(false)
    }
  }

  const weekly = data?.weeklyCount ?? 0

  return (
    <DiaryShell segment="year" f7router={f7router}>
      <section className="rd-card rd-year-card" data-testid="diary-year-card" aria-labelledby="diary-year-title">
        <div className="rd-chart-head">
          <h2 className="rd-card-title" id="diary-year-title">
            Год в пикселях
          </h2>
          <div className="rd-chart-month">
            <button
              type="button"
              className="rd-chart-arrow"
              aria-label="Предыдущий год"
              disabled={year <= thisYear - YEARS_BACK}
              data-testid="diary-year-prev"
              onClick={() => setYear(year - 1)}
            >
              <Icon f7="chevron_left" size={16} />
            </button>
            <span className="rd-chart-month-name" data-testid="diary-year-title-year">
              {year}
            </span>
            <button
              type="button"
              className="rd-chart-arrow"
              aria-label="Следующий год"
              disabled={year >= thisYear}
              data-testid="diary-year-next"
              onClick={() => setYear(year + 1)}
            >
              <Icon f7="chevron_right" size={16} />
            </button>
          </div>
        </div>
        <p className="rd-caption">Каждый квадратик — один день. Отмечай настроение, и год раскрасится</p>

        <div className="rd-year" data-testid="diary-year-grid">
          <div className="rd-year-row rd-year-row--ticks" aria-hidden="true">
            <span className="rd-year-month" />
            {Array.from({ length: 31 }, (_, d) => (
              <span key={d} className="rd-year-tick">
                {DAY_TICKS.includes(d + 1) ? d + 1 : ''}
              </span>
            ))}
          </div>
          {grid.map((row, m) => (
            <div key={m} className="rd-year-row">
              <span className="rd-year-month" aria-hidden="true">
                {monthName(m + 1).slice(0, 3)}
              </span>
              {row.map((cell) => (
                <button
                  key={cell.date}
                  type="button"
                  className={`rd-year-cell${cell.future ? ' rd-year-cell--future' : ''}${picked === cell.date ? ' rd-year-cell--picked' : ''}`}
                  style={cell.entry ? { background: moodColor(cell.entry.mood) } : undefined}
                  aria-label={cell.entry ? dayCaption(cell.entry) : `${longDate(cell.date)} — нет отметки`}
                  data-testid="diary-year-cell"
                  data-date={cell.date}
                  data-mood={cell.entry?.mood ?? ''}
                  onClick={() => setPicked(cell.date)}
                />
              ))}
            </div>
          ))}
          {!data && !error && (
            <Block className="text-align-center">
              <Preloader size={20} />
            </Block>
          )}
        </div>
        {error && <p className="rd-form-error">{error}</p>}

        <p className="rd-year-caption" data-testid="diary-year-caption" aria-live="polite">
          {picked
            ? pickedEntry
              ? dayCaption(pickedEntry)
              : `${longDate(picked)} — нет отметки`
            : ' '}
        </p>

        <div className="rd-year-legend" aria-label="Легенда">
          <span>{MOOD_LABELS[1]}</span>
          {MOOD_LEVELS.map((level) => (
            <i key={level} className="rd-year-legend-cell" style={{ background: moodColor(level) }} />
          ))}
          <span>{MOOD_LABELS[5]}</span>
        </div>

        {data && (
          <div className="rd-year-plaques">
            <div className="rd-plaque" data-testid="diary-year-marked">
              Отмечено дней: {data.markedDays}
            </div>
            {data.mostFrequent && (
              <div className="rd-plaque" data-testid="diary-year-top">
                Чаще всего: {MOOD_LABELS[data.mostFrequent].toLowerCase()}
              </div>
            )}
          </div>
        )}
        <Button round outline disabled={!data} data-testid="diary-year-share" onClick={() => void share()}>
          Поделиться моим годом
        </Button>
        {shareNote && <p className="rd-caption">{shareNote}</p>}
      </section>

      <section className="rd-card rd-story-card" data-testid="diary-story-card" aria-labelledby="diary-story-title">
        <h2 className="rd-card-title" id="diary-story-title">
          Итоги года
        </h2>
        {data?.story ? (
          <>
            <p className="rd-summary-text" data-testid="diary-story-text">
              {data.story.text}
            </p>
            {weekly - data.story.weeklyCount >= YEAR_STORY_EXTEND_WEEKS && (
              <Button small round outline disabled={storyBusy} data-testid="diary-story-extend" onClick={() => void buildStory()}>
                {storyBusy ? <Preloader size={16} /> : 'Дописать историю'}
              </Button>
            )}
          </>
        ) : (
          <>
            <p className="rd-muted">
              Каждые «Итоги недели» сохраняются сюда. Собрано {weekly} из {YEAR_STORY_MIN_WEEKS} — когда накопится, я
              напишу большую историю твоего года
            </p>
            <div
              className="rd-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={YEAR_STORY_MIN_WEEKS}
              aria-valuenow={Math.min(weekly, YEAR_STORY_MIN_WEEKS)}
              data-testid="diary-story-progress"
            >
              <span style={{ width: `${(Math.min(weekly, YEAR_STORY_MIN_WEEKS) / YEAR_STORY_MIN_WEEKS) * 100}%` }} />
            </div>
            {weekly >= YEAR_STORY_MIN_WEEKS && (
              <Button small round fill disabled={storyBusy} data-testid="diary-story-build" onClick={() => void buildStory()}>
                {storyBusy ? <Preloader size={16} /> : 'Собрать историю года'}
              </Button>
            )}
          </>
        )}
        {storyError && <p className="rd-form-error">{storyError}</p>}
      </section>
    </DiaryShell>
  )
}
