// openspec/changes/add-fast-dialog-start, «Согласие при первом действии»: the window over home
// carries the gate's content — the required unticked checkbox with the document links and a
// "Продолжить" that stays disabled until the tick — plus a close that sends nothing. Opening and
// closing (Esc, the backdrop), the waiting intent and the start that follows "Продолжить" are
// covered by the e2e suite; here the markup contract.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConsentModalContent } from './ConsentModal'

const PROPS = {
  termsUrl: 'https://ryadom.example/terms',
  consentUrl: 'https://ryadom.example/consent',
  onContinue: () => {},
  onClose: () => {},
}

describe('ConsentModalContent', () => {
  it('shows the required 18+ checkbox unticked and "Продолжить" disabled until the tick', () => {
    const markup = renderToStaticMarkup(<ConsentModalContent {...PROPS} />)
    expect(markup).toContain('data-testid="consent-modal"')
    expect(markup).toContain('Один раз подтверди, что согласен(на), — и можно говорить.')
    expect(markup).toContain('Мне есть 18 лет')
    const checkbox = /<input[^>]*data-testid="data-consent-toggle"[^>]*>/.exec(markup)?.[0]
    expect(checkbox).toBeDefined()
    expect(checkbox).toContain('type="checkbox"')
    expect(checkbox).toContain('required')
    // Unticked by default: the start the window guards may not run before an explicit mark.
    expect(checkbox).not.toMatch(/\schecked[="/>]/)
    const button = /<button[^>]*data-testid="consent-continue"[^>]*>/.exec(markup)?.[0]
    expect(button).toBeDefined()
    expect(button).toContain('disabled')
    expect(button).not.toContain('type="submit"')
  })

  it('links the documents in a new tab, so the window, the draft and the intent stay put', () => {
    const markup = renderToStaticMarkup(<ConsentModalContent {...PROPS} />)
    expect(markup).toContain('href="https://ryadom.example/terms"')
    expect(markup).toContain('href="https://ryadom.example/consent"')
    expect(markup).toContain('target="_blank"')
  })

  it('has a close control that only closes', () => {
    const markup = renderToStaticMarkup(<ConsentModalContent {...PROPS} />)
    const close = /<button[^>]*data-testid="consent-close"[^>]*>/.exec(markup)?.[0]
    expect(close).toBeDefined()
    expect(close).toContain('type="button"')
    expect(close).toContain('aria-label="Закрыть"')
  })
})
