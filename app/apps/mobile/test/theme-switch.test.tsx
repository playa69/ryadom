/** The PWA/Telegram theme switch: what a horizontal swipe across the pill asks for. */
import { describe, expect, it, vi } from 'vitest'

vi.mock('framework7-react', () => ({ Icon: () => null }))
// As the native shell, so the module-level schedule state never touches window/localStorage.
vi.mock('../src/client/lib/platform', () => ({ isNative: () => true }))

import { swipeTheme } from '../src/client/components/ThemeSwitch'

describe('переключатель темы PWA/Telegram', () => {
  it('свайп вправо включает ночь, влево — день', () => {
    // The knob follows the finger across the pill.
    expect(swipeTheme(40)).toBe('dark')
    expect(swipeTheme(-40)).toBe('light')
  })

  it('короткое движение остаётся tap и тему не выбирает', () => {
    // Below the 24px threshold the pointer sequence resolves to a click, which toggles the theme.
    expect(swipeTheme(0)).toBeNull()
    expect(swipeTheme(23)).toBeNull()
    expect(swipeTheme(-23)).toBeNull()
    expect(swipeTheme(24)).toBe('dark')
    expect(swipeTheme(-24)).toBe('light')
  })
})
