/** The shared start composer of the PWA/Telegram start screens: the suggestions contract and keys. */
import type { ComponentProps, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('framework7-react', () => ({
  // The strip's markup is what is tested here; the Framework7-only props do not belong to a button.
  Button: ({
    children,
    small,
    outline,
    round,
    ...props
  }: ComponentProps<'button'> & Record<string, unknown>) => (
    <button {...props}>{children as ReactNode}</button>
  ),
}))

import { DIALOG_START_SUGGESTIONS } from '@ryadom/client-core/dialog-start'
import { InputLimit } from '@ryadom/contracts/api/limits'
import StartComposer, { chipsScrollTarget, isSubmitKey } from '../src/client/components/StartComposer'

describe('стартовый композер PWA/Telegram', () => {
  it('три общие подсказки, те же, что на вебе', () => {
    // `openspec/changes/add-fast-dialog-start`, «Главный экран мобильного клиента»
    // («(PWA, Telegram) Подсказка подставляет черновик»).
    expect([...DIALOG_START_SUGGESTIONS]).toEqual(['Хочу выговориться', 'Мне тревожно', 'Просто поговорить'])
  })

  it('Enter отправляет, Shift+Enter — новая строка', () => {
    // `openspec/changes/add-fast-dialog-start`, «Начало разговора с главного экрана»
    // («(PWA, Telegram) Набранный текст»).
    expect(isSubmitKey({ key: 'Enter', shiftKey: false })).toBe(true)
    expect(isSubmitKey({ key: 'Enter', shiftKey: true })).toBe(false)
    expect(isSubmitKey({ key: 'a', shiftKey: false })).toBe(false)
  })

  it('предел поля — общий лимит сообщения в 4000 знаков', () => {
    // `openspec/changes/add-fast-dialog-start`, «Главный экран мобильного клиента»
    // («(PWA, Telegram) Поле ограничивает черновик»).
    expect(InputLimit.MessageMax).toBe(4000)
  })

  it('подсказки — чипы одной лентой, лента фокусируема и названа для скринридера', () => {
    // `openspec/changes/add-fast-dialog-start`, «Главный экран мобильного клиента»: лента прокручивается
    // по горизонтали, а не переносится на три строки; фокус на ленте даёт прокрутку с клавиатуры.
    const markup = renderToStaticMarkup(
      <StartComposer draft="" onDraftChange={() => {}} onSubmit={() => {}} />,
    )
    expect(markup).toContain('class="rd-start-suggestions"')
    expect(markup).toContain('role="group"')
    expect(markup).toContain('aria-label="Подсказки первого сообщения"')
    expect(markup).toContain('tabindex="0"')
    expect(markup.match(/data-testid="start-suggestion"/g)).toHaveLength(3)
  })

  it('стрелки и Home/End прокручивают ленту, остальные клавиши — нет', () => {
    // `openspec/changes/add-fast-dialog-start`, «Главный экран мобильного клиента»: лента фокусируема
    // и прокручивается с клавиатуры; Tab и поле ввода сохраняют нативное поведение.
    // Arrows step by a viewport; ArrowLeft clamps at the start, scrollTo clamps the right edge.
    expect(chipsScrollTarget('ArrowLeft', 480, 320, 2000)).toBe(160)
    expect(chipsScrollTarget('ArrowLeft', 100, 320, 2000)).toBe(0)
    expect(chipsScrollTarget('ArrowRight', 480, 320, 2000)).toBe(800)
    // Home and End go to the very start and end; End targets scrollWidth (scrollTo clamps it).
    expect(chipsScrollTarget('Home', 480, 320, 2000)).toBe(0)
    expect(chipsScrollTarget('End', 480, 320, 2000)).toBe(2000)
    expect(chipsScrollTarget('Tab', 480, 320, 2000)).toBeNull()
    expect(chipsScrollTarget('Enter', 480, 320, 2000)).toBeNull()
    expect(chipsScrollTarget('ArrowUp', 480, 320, 2000)).toBeNull()
  })
})
