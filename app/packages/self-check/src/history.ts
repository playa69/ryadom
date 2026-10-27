import { band as bandOf } from './score'
import type { SelfCheckTest, Tone } from './types'

/** What the screens need of a saved result: the server's `SelfCheckResultApi` without the dependency on contracts. */
export interface SavedResult {
  id: string
  testId: string
  testVersion: number
  score: number
  band: string
  takenAt: string
}

const MONTHS = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
]

/** «19 октября»: the day in the device's zone, with the year only when it is not this one. */
export function formatDay(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`
  return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`
}

/** The tone of the level a score falls in today, for the dot beside a saved result; `calm` when the bands changed under it. */
export function toneOfResult(test: SelfCheckTest, r: SavedResult): Tone {
  return bandOf(test, r.score)?.tone ?? 'calm'
}

/** «19 октября: 8/21 — лёгкая выраженность»: the line of a saved result in the block «Самопроверка». */
export function savedLine(test: SelfCheckTest, r: SavedResult, now?: Date): string {
  return `${formatDay(r.takenAt, now)}: ${r.score}/${test.scoring.max}${r.band ? ` — ${r.band}` : ''}`
}

/** The chart needs two results; the order on the screen is oldest first. */
export function chartResults(results: readonly SavedResult[]): SavedResult[] | null {
  if (results.length < 2) return null
  return [...results].sort((a, b) => a.takenAt.localeCompare(b.takenAt))
}

/** Points of the chart in a `width` × `height` box, with `pad` around: x by time, y by score from 0 to the test's maximum. */
export function chartPoints(
  test: SelfCheckTest,
  results: readonly SavedResult[],
  width: number,
  height: number,
  pad = 10,
): { x: number; y: number; result: SavedResult }[] {
  const ordered = chartResults(results) ?? []
  if (ordered.length === 0) return []
  const t0 = Date.parse(ordered[0]!.takenAt)
  const span = Math.max(Date.parse(ordered[ordered.length - 1]!.takenAt) - t0, 1)
  return ordered.map((result) => ({
    x: pad + ((Date.parse(result.takenAt) - t0) / span) * (width - 2 * pad),
    y: pad + (1 - result.score / test.scoring.max) * (height - 2 * pad),
    result,
  }))
}

/** True when the results were saved under more than one version of the test: the comparison is only approximate. */
export function versionsDiffer(results: readonly SavedResult[]): boolean {
  return new Set(results.map((r) => r.testVersion)).size > 1
}
