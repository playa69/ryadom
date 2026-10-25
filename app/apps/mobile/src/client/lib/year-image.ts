import { MOOD_COLORS, buildYearGrid } from '@ryadom/client-core/diary'
import type { MoodCheckinApi } from '@ryadom/contracts/api/diary'
import { isNative } from './platform'

/**
 * «Поделиться моим годом»: the grid drawn on a canvas, on the device, so nothing but the picture leaves it.
 * The picture carries the year, the grid, the legend and the line of the app: no factors, no dates, no
 * name and no texts (`REQ-WELL-01`).
 */

const CELL = 22
const GAP = 4
const PAD = 56
const LEGEND = 'Мой год в Слышу Рядом · слышу-рядом.рф'
const EMPTY = 'rgba(255,255,255,0.10)'
const FUTURE = 'rgba(255,255,255,0.04)'

export function drawYearImage(
  canvas: HTMLCanvasElement,
  year: number,
  days: readonly MoodCheckinApi[],
  today: string,
): void {
  const grid = buildYearGrid(year, days, today)
  const width = PAD * 2 + 31 * (CELL + GAP) - GAP
  const height = PAD * 2 + 100 + 12 * (CELL + GAP) - GAP + 90
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.fillStyle = '#00051a'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = '#f1f4ff'
  ctx.font = '700 56px sans-serif'
  ctx.textBaseline = 'top'
  ctx.fillText(String(year), PAD, PAD)
  const top = PAD + 100
  grid.forEach((row, m) => {
    row.forEach((cell, d) => {
      ctx.fillStyle = cell.entry ? MOOD_COLORS[cell.entry.mood] : cell.future ? FUTURE : EMPTY
      ctx.beginPath()
      ctx.roundRect(PAD + d * (CELL + GAP), top + m * (CELL + GAP), CELL, CELL, 5)
      ctx.fill()
    })
  })
  const legendY = top + 12 * (CELL + GAP) + 16
  ;([1, 2, 3, 4, 5] as const).forEach((level, i) => {
    ctx.fillStyle = MOOD_COLORS[level]
    ctx.beginPath()
    ctx.roundRect(PAD + i * (CELL + GAP), legendY, CELL, CELL, 5)
    ctx.fill()
  })
  ctx.fillStyle = '#b0b9d8'
  ctx.font = '400 24px sans-serif'
  ctx.fillText(LEGEND, PAD, legendY + CELL + 18)
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
}

/** Hands the picture over: the system share sheet with a file where there is one, a download elsewhere. */
export async function shareYearImage(
  year: number,
  days: readonly MoodCheckinApi[],
  today: string,
): Promise<'shared' | 'downloaded' | 'failed' | 'cancelled'> {
  const canvas = document.createElement('canvas')
  drawYearImage(canvas, year, days, today)
  const blob = await toBlob(canvas)
  if (!blob) return 'failed'
  const file = new File([blob], `ryadom-${year}.png`, { type: 'image/png' })
  if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: `Мой год ${year}` })
      return 'shared'
    } catch (error) {
      // The person closed the sheet: the picture was offered, which is what they asked for.
      if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled'
    }
  }
  // A store build's WebView ignores download links; there is nothing more to try with it.
  if (isNative()) return 'failed'
  const url = URL.createObjectURL(blob)
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = file.name
    link.rel = 'noopener'
    // Framework7 takes every other link in the document for a route and cancels its default action.
    link.className = 'external'
    document.body.append(link)
    link.click()
    link.remove()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return 'downloaded'
}
