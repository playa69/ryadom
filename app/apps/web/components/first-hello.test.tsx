// `openspec/changes/rework-web-first-screen`, «Первый экран: разговор с первого действия»: the newcomer's
// first screen is an invitation, not a form. The window it opens, the start and the layout on a phone are
// covered by the e2e suite; here the markup contract.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import FirstHello from './FirstHello'

const PROPS = { onVoice: () => {}, onText: () => {} }

describe('FirstHello', () => {
  it('greets in one heading and offers the voice first, the keyboard beside it', () => {
    const markup = renderToStaticMarkup(<FirstHello {...PROPS} />)
    expect(markup.match(/<h1/g)).toHaveLength(1)
    expect(markup).toContain('Привет! Я рядом.')
    expect(markup).toContain('Поговорим?')
    expect(markup).toMatch(/<button[^>]*data-testid="hello-voice"[^>]*>.*Поговорить<\/button>/s)
    const text = /<button[^>]*data-testid="hello-text"[^>]*>/.exec(markup)?.[0]
    expect(text).toContain('aria-label="Написать текстом"')
  })

  it('says what the service is at the foot, with the emergency number', () => {
    const markup = renderToStaticMarkup(<FirstHello {...PROPS} />)
    expect(markup).toContain('data-testid="hello-plaque"')
    expect(markup).toContain('бесплатный ИИ-собеседник, без регистрации')
    expect(markup).toContain('не психотерапия')
    expect(markup).toContain('В опасной ситуации звони 112.')
  })

  it('has no box, no suggestions and no consent tick of its own', () => {
    const markup = renderToStaticMarkup(<FirstHello {...PROPS} />)
    expect(markup).not.toContain('<textarea')
    expect(markup).not.toContain('type="checkbox"')
  })

  it('holds both buttons while a start runs and shows a failed one', () => {
    const markup = renderToStaticMarkup(<FirstHello {...PROPS} busy error="Не получилось начать разговор" />)
    expect(/<button[^>]*data-testid="hello-voice"[^>]*>/.exec(markup)?.[0]).toContain('disabled')
    expect(/<button[^>]*data-testid="hello-text"[^>]*>/.exec(markup)?.[0]).toContain('disabled')
    expect(markup).toContain('role="alert"')
  })
})
