// openspec/changes/add-fast-dialog-start, «Главный экран веб-клиента», «Настройки не конкурируют с
// началом»: the memory choice folds into a details/summary that starts collapsed; the accessible
// disclosure markup is native, so keyboard and screen readers get it for free.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ConversationSettings from './ConversationSettings'

describe('ConversationSettings', () => {
  it('is a collapsed details with the summary "Настроить разговор" around its content', () => {
    const markup = renderToStaticMarkup(
      <ConversationSettings>
        <div data-testid="memory-switch">Запоминать важное</div>
      </ConversationSettings>,
    )
    expect(markup).toContain('data-testid="home-settings"')
    // Collapsed by default: no `open` attribute on the details.
    expect(markup).toMatch(/<details(?![^>]*\bopen\b)[^>]*>/)
    expect(markup).toContain('<summary')
    expect(markup).toContain('Настроить разговор')
    expect(markup).toContain('Запоминать важное')
  })
})
