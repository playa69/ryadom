import { describe, expect, it } from 'vitest'
import { byId } from '../src/catalog'
import { chartPoints, chartResults, formatDay, savedLine, toneOfResult, versionsDiffer, type SavedResult } from '../src/history'

const gad7 = byId('gad7')!
const r = (id: string, takenAt: string, score: number, testVersion = 1): SavedResult => ({ id, testId: 'gad7', testVersion, score, band: 'лёгкая выраженность', takenAt })

describe('история результатов', () => {
  it('строка: «19 октября: 8/21 — лёгкая выраженность», год только чужой', () => {
    const now = new Date(2026, 9, 27)
    expect(savedLine(gad7, r('a', new Date(2026, 9, 19, 12).toISOString(), 8), now)).toBe('19 октября: 8/21 — лёгкая выраженность')
    expect(formatDay(new Date(2025, 11, 3, 12).toISOString(), now)).toBe('3 декабря 2025')
  })
  it('график — со второго результата, старые слева', () => {
    expect(chartResults([r('a', '2026-10-01T10:00:00Z', 5)])).toBeNull()
    const pts = chartPoints(gad7, [r('b', '2026-10-15T10:00:00Z', 3), r('a', '2026-10-01T10:00:00Z', 12)], 300, 100)
    expect(pts.map((p) => p.result.id)).toEqual(['a', 'b'])
    expect(pts[0]!.x).toBe(10)
    expect(pts[1]!.x).toBe(290)
    expect(pts[0]!.y).toBeLessThan(pts[1]!.y) // a higher score is higher on the chart
  })
  it('тон по баллу и пометка о смене версии', () => {
    expect(toneOfResult(gad7, r('a', '2026-10-01T10:00:00Z', 3))).toBe('calm')
    expect(versionsDiffer([r('a', '2026-10-01T10:00:00Z', 3), r('b', '2026-10-02T10:00:00Z', 3, 2)])).toBe(true)
    expect(versionsDiffer([r('a', '2026-10-01T10:00:00Z', 3)])).toBe(false)
  })
})
