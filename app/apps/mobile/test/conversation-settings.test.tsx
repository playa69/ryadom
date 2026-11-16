// openspec/changes/add-fast-dialog-start, «Главный экран мобильного клиента»: выбор памяти складывается
// в details/summary «Настроить разговор», свёрнутый по умолчанию, как на вебе; нативная разметка
// disclosure сама доступна клавиатуре и скринридеру.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('framework7-react', () => ({ Icon: () => null }))

import ConversationSettings from '../src/client/components/ConversationSettings'

describe('ConversationSettings (PWA/Telegram)', () => {
  it('свёрнутый details с summary «Настроить разговор» вокруг содержимого', () => {
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
