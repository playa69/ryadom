import { describe, expect, it } from 'vitest'
import type { DialogListItemApiResponse } from '@ryadom/contracts/api/dialogs'
import { DialogMode } from '@ryadom/contracts/api/dialogs'
import { DialogMemoryMode } from '@ryadom/contracts/api/memory'
import { groupJournal } from './journal-groups'

function at(iso: string, id = iso): DialogListItemApiResponse {
  return {
    dialogId: id,
    mode: DialogMode.Vent,
    startedAt: iso,
    endedAt: null,
    summary: null,
    memoryMode: DialogMemoryMode.On,
  }
}

// 15:00 local on a Wednesday.
const NOW = new Date(2026, 9, 14, 15, 0, 0)

describe('groupJournal', () => {
  it('splits by calendar day and keeps the incoming order inside a group', () => {
    const groups = groupJournal(
      [
        at(new Date(2026, 9, 14, 9, 30).toISOString(), 'a'),
        at(new Date(2026, 9, 14, 0, 5).toISOString(), 'b'),
        at(new Date(2026, 9, 13, 23, 50).toISOString(), 'c'),
        at(new Date(2026, 9, 9, 12, 0).toISOString(), 'd'),
        at(new Date(2026, 8, 1, 12, 0).toISOString(), 'e'),
      ],
      NOW,
    )
    expect(groups.map((g) => [g.label, g.items.map((i) => i.dialogId)])).toEqual([
      ['Сегодня', ['a', 'b']],
      ['Вчера', ['c']],
      ['Последние 7 дней', ['d']],
      ['Ранее', ['e']],
    ])
  })

  it('leaves out empty groups', () => {
    const groups = groupJournal([at(new Date(2026, 9, 14, 8, 0).toISOString())], NOW)
    expect(groups.map((g) => g.key)).toEqual(['today'])
    expect(groupJournal([], NOW)).toEqual([])
  })

  it('treats the seventh day back as the week and the eighth as earlier', () => {
    const seventh = at(new Date(2026, 9, 7, 0, 0).toISOString(), 'seventh')
    const eighth = at(new Date(2026, 9, 6, 23, 59).toISOString(), 'eighth')
    const groups = groupJournal([seventh, eighth], NOW)
    expect(groups.map((g) => [g.key, g.items.map((i) => i.dialogId)])).toEqual([
      ['week', ['seventh']],
      ['earlier', ['eighth']],
    ])
  })

  it('puts an unreadable date into earlier instead of dropping the conversation', () => {
    const groups = groupJournal([at('not a date', 'x')], NOW)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.key).toBe('earlier')
  })
})
