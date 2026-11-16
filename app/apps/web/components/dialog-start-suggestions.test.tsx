// openspec/changes/add-fast-dialog-start, «Главный экран веб-клиента», «Подсказка подставляет
// черновик»: the three suggestions are the shared contract with the mobile client, and a pick only
// fills the draft — these buttons are plain buttons, not a form submit and not a dialog mode.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DIALOG_START_SUGGESTIONS } from '@ryadom/client-core/dialog-start'
import DialogStartSuggestions from './DialogStartSuggestions'

describe('DIALOG_START_SUGGESTIONS', () => {
  it('are the three shared starts, in order', () => {
    expect([...DIALOG_START_SUGGESTIONS]).toEqual(['Хочу выговориться', 'Мне тревожно', 'Просто поговорить'])
  })
})

describe('DialogStartSuggestions', () => {
  it('renders one plain button per suggestion, each with its text', () => {
    const markup = renderToStaticMarkup(<DialogStartSuggestions onPick={() => {}} />)
    expect(markup).toContain('data-testid="home-suggestions"')
    for (const [index, suggestion] of DIALOG_START_SUGGESTIONS.entries()) {
      expect(markup).toContain(`data-testid="home-suggestion-${index + 1}"`)
      expect(markup).toContain(`type="button"`)
      expect(markup).toContain(suggestion)
    }
    // No suggestion may submit the composer's form: a pick must not start anything.
    expect(markup).not.toContain('type="submit"')
  })
})
