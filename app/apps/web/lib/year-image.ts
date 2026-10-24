import { MOOD_COLORS, MOOD_LABELS, buildYearGrid, type YearCell } from '@ryadom/client-core/diary'
import type { MoodCheckinApi, MoodLevel } from '@ryadom/contracts/api/diary'

/**
 * The picture "Поделиться моим годом" (`REQ-WELL-01`): the grid, the year, the legend and one line.
 * No factors, dates, name or summary texts are drawn: only the colours of the days.
 */

export const YEAR_IMAGE_FOOTER = 'Мой год в Слышу Рядом · слышу-рядом.рф'
export const yearImageFileName = (year: number): string => `ryadom-${year}.png`

const WIDTH = 1080
const HEIGHT = 1350

function drawGrid(ctx: CanvasRenderingContext2D, rows: YearCell[][], x0: number, y0: number, size: number, gap: number) {
  rows.forEach((row, m) => {
    row.forEach((cell, d) => {
      ctx.fillStyle = cell.entry ? MOOD_COLORS[cell.entry.mood] : cell.future ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.12)'
      const x = x0 + d * (size + gap)
      const y = y0 + m * (size + gap)
      ctx.beginPath()
      ctx.roundRect(x, y, size, size, 5)
      ctx.fill()
    })
  })
}

export function drawYearImage(canvas: HTMLCanvasElement, year: number, days: readonly MoodCheckinApi[], today: string): void {
  canvas.width = WIDTH
  canvas.height = HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is not available')
  ctx.fillStyle = '#00051a'
  ctx.fillRect(0, 0, WIDTH, HEIGHT)

  ctx.fillStyle = '#ffffff'
  ctx.font = '700 120px system-ui, sans-serif'
  ctx.textBaseline = 'top'
  ctx.fillText(String(year), 70, 80)

  const gap = 5
  const size = Math.floor((WIDTH - 140 - gap * 30) / 31)
  drawGrid(ctx, buildYearGrid(year, days, today), 70, 280, size, gap)

  // Legend: the five colours, from "Тяжело" to "Отлично".
  const legendY = 280 + 12 * (size + gap) + 50
  ctx.font = '500 34px system-ui, sans-serif'
  ctx.fillStyle = '#b8c2d9'
  ctx.fillText(MOOD_LABELS[1], 70, legendY)
  ;([1, 2, 3, 4, 5] as MoodLevel[]).forEach((level, i) => {
    ctx.fillStyle = MOOD_COLORS[level]
    ctx.beginPath()
    ctx.roundRect(300 + i * 90, legendY - 4, 70, 46, 8)
    ctx.fill()
  })
  ctx.fillStyle = '#b8c2d9'
  ctx.fillText(MOOD_LABELS[5], 300 + 5 * 90 + 10, legendY)

  ctx.font = '600 38px system-ui, sans-serif'
  ctx.fillStyle = '#ffffff'
  ctx.fillText(YEAR_IMAGE_FOOTER, 70, HEIGHT - 120)
}

export async function renderYearImage(year: number, days: readonly MoodCheckinApi[], today: string): Promise<Blob> {
  const canvas = document.createElement('canvas')
  drawYearImage(canvas, year, days, today)
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('No image'))), 'image/png'),
  )
}

/** The system share sheet with the file where the browser has one; a download everywhere else. */
export async function shareYearImage(year: number, blob: Blob): Promise<'shared' | 'downloaded'> {
  const file = new File([blob], yearImageFileName(year), { type: 'image/png' })
  if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] })
      return 'shared'
    } catch (error) {
      // The person closed the sheet: nothing to download after that.
      if (error instanceof DOMException && error.name === 'AbortError') return 'shared'
    }
  }
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = yearImageFileName(year)
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return 'downloaded'
}
