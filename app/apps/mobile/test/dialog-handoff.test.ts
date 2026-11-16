import { describe, expect, it } from 'vitest'

import { takeDialogHandoff } from '../src/client/components/pages/dialog/dialog-handoff'

// `openspec/changes/add-fast-dialog-start`, «Начало разговора с главного экрана».
describe('одноразовый handoff старта диалога', () => {
  it('отдаёт вид и текст первого сообщения ровно один раз', () => {
    // «(PWA, Telegram) Набранный текст»: текстовый старт открывает диалог в текстовом виде.
    expect(takeDialogHandoff('d1', 'text', 'Мне тревожно')).toEqual({ mode: 'text', text: 'Мне тревожно' })
    // «(PWA, Telegram) Текст с главной уходит один раз»: повторный mount с теми же route props
    // возвращает вид, но не текст — сообщение не ставится снова.
    expect(takeDialogHandoff('d1', 'text', 'Мне тревожно')).toEqual({ mode: 'text' })
  })

  it('обрезает текст и не считает пробелы сообщением', () => {
    expect(takeDialogHandoff('d2', 'text', '  Хочу выговориться  ')).toEqual({
      mode: 'text',
      text: 'Хочу выговориться',
    })
    expect(takeDialogHandoff('d3', 'text', '   ')).toEqual({ mode: 'text' })
  })

  it('без props handoff нет: голосовой старт и открытие не с главной идут как раньше', () => {
    // «Поговорить» без текста: ни вид, ни текст не навязываются.
    expect(takeDialogHandoff('d4')).toBeNull()
    expect(takeDialogHandoff('d4', undefined, '')).toBeNull()
  })

  it('текст без явного вида не меняет вид: по умолчанию голосовой', () => {
    expect(takeDialogHandoff('d5', undefined, 'Просто поговорить')).toEqual({
      mode: 'voice',
      text: 'Просто поговорить',
    })
  })

  it('голосовой вид с текстом не повторяет текст при возврате на экран', () => {
    // «(PWA, Telegram) Текст с главной уходит один раз»: reconnect и возврат не создают дубль.
    expect(takeDialogHandoff('d6', 'voice', 'первое')).toEqual({ mode: 'voice', text: 'первое' })
    expect(takeDialogHandoff('d6', 'voice', 'первое')).toEqual({ mode: 'voice' })
  })

  it('диалоги поглощаются независимо друг от друга', () => {
    expect(takeDialogHandoff('d7', 'text', 'один')).toEqual({ mode: 'text', text: 'один' })
    expect(takeDialogHandoff('d8', 'text', 'два')).toEqual({ mode: 'text', text: 'два' })
    expect(takeDialogHandoff('d7', 'text', 'один')).toEqual({ mode: 'text' })
  })

  it('новый текст в том же незавершённом диалоге не теряется без перезагрузки', () => {
    expect(takeDialogHandoff('d9', 'text', 'первое')).toEqual({ mode: 'text', text: 'первое' })
    expect(takeDialogHandoff('d9', 'text', 'первое')).toEqual({ mode: 'text' })
    expect(takeDialogHandoff('d9', 'text', 'второе')).toEqual({ mode: 'text', text: 'второе' })
    expect(takeDialogHandoff('d9', 'text', 'второе')).toEqual({ mode: 'text' })
  })
})
