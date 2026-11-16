// openspec/changes/add-fast-dialog-start, «Поле ввода главного экрана веб-клиента»: the controlled
// draft lets home fill the box from a suggestion, while the dialog composer without the new props
// keeps its internal state. Interaction (typing, Enter, a failed start keeping the draft) is
// covered by the e2e suite; here the markup contract.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ChatComposer from './ChatComposer'

const BASE = {
  variant: 'hero' as const,
  testIdPrefix: 'home' as const,
  placeholder: 'Напиши или скажи, что на душе…',
  emptyLabel: 'Поговорить',
  onSubmit: () => {},
  onMic: () => {},
}

describe('ChatComposer draft modes', () => {
  it('without the controlled props the box starts empty, as before', () => {
    const markup = renderToStaticMarkup(<ChatComposer {...BASE} />)
    expect(markup).toContain('data-testid="home-input"')
    expect(markup).not.toMatch(/<textarea[^>]*>[^<]+<\/textarea>/)
    // An empty field keeps the voice start under its own name.
    expect(markup).toContain('aria-label="Поговорить"')
  })

  it('a controlled draft renders in the field and the send button says "Отправить"', () => {
    const markup = renderToStaticMarkup(
      <ChatComposer {...BASE} draft="Мне тревожно" onDraftChange={() => {}} />,
    )
    expect(markup).toContain('>Мне тревожно</textarea>')
    expect(markup).toContain('aria-label="Отправить"')
  })

  it('a controlled empty draft is still controlled: the button says "Поговорить"', () => {
    const markup = renderToStaticMarkup(<ChatComposer {...BASE} draft="" onDraftChange={() => {}} />)
    expect(markup).toContain('aria-label="Поговорить"')
  })

  it('the dialog dock without the new props renders its own empty field', () => {
    const markup = renderToStaticMarkup(
      <ChatComposer
        variant="dock"
        testIdPrefix="dialog"
        placeholder="Напиши, что происходит…"
        onSubmit={() => {}}
        onMic={() => {}}
      />,
    )
    expect(markup).toContain('data-testid="dialog-input"')
    expect(markup).toContain('data-testid="dialog-mic"')
  })
})
