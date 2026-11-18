// openspec/changes/add-fast-dialog-start, «Русскоязычный интерфейс и оформление», «Ручное
// переключение»: the switch is a `switch` named after the action the next press performs, with a
// 44×44 hit area. Tap/swipe/keyboard behavior is covered by the e2e suite; here the markup contract.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ThemeSwitch } from './theme-switch'

describe('ThemeSwitch', () => {
  it('is an accessible switch with a 44px hit area, named after the next action', () => {
    // Without a DOM the server snapshot applies: the default dark theme.
    const markup = renderToStaticMarkup(<ThemeSwitch />)
    expect(markup).toContain('data-testid="theme-switch"')
    expect(markup).toContain('role="switch"')
    expect(markup).toContain('aria-checked="true"')
    expect(markup).toContain('aria-label="Включить светлую тему"')
    expect(markup).toContain('size-11')
    // A plain button: it must never submit a form it could share a page with.
    expect(markup).toContain('type="button"')
    // The thumb carries the icon of the theme in effect, never both at once.
    expect(markup).toContain('lucide-moon')
    expect(markup).not.toContain('lucide-sun')
  })
})
