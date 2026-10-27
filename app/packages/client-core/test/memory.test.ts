/**
 * Memory on the client: the groups of the screen, the labels of a fact, its actions, the card "Я
 * запомнил" (whether to show it and the polling behind it) and "Забыть" with time to take it back.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MEMORY_CONSENT_VERSION,
  MemoryChangeOp,
  MemoryChangesStatus,
  MemoryFactCategory,
  MemoryFactOrigin,
  MemoryFactSensitivity,
  MemoryFactStatus,
  type MemoryChangesApiResponse,
  type MemoryFactApiResponse,
} from '@ryadom/contracts/api/memory'
import { InputLimit } from '@ryadom/contracts/api/limits'
import type { ApiOutcome } from '../src/errors'
import {
  FORGET_UNDO_MS,
  MEMORY_CARD_MAX_ITEMS,
  cleanPersonSlots,
  createMemoryCard,
  createPendingForgets,
  dialogMemoryMark,
  groupMemory,
  memoryCardContent,
  memoryEditKind,
  memoryExportFileName,
  memoryFactBody,
  memoryFactDraft,
  memoryFactActions,
  memoryFactChange,
  memoryFactSource,
  memoryInUse,
  memorySectionStatus,
  memoryTextProblem,
  needsMemoryConsent,
  newMemoryFactCategories,
  personSlotsProblem,
  pollMemoryChanges,
  shouldShowMemoryCard,
  shouldWatchMemoryChanges,
  styleSlotsProblem,
} from '../src/memory'

let nextId = 1

function fact(patch: Partial<MemoryFactApiResponse> = {}): MemoryFactApiResponse {
  const id = `f-${nextId++}`
  return {
    id,
    category: MemoryFactCategory.Interest,
    text: `факт ${id}`,
    slots: null,
    importance: 3,
    confidence: 0.9,
    status: MemoryFactStatus.Active,
    origin: MemoryFactOrigin.Auto,
    sensitivity: MemoryFactSensitivity.Normal,
    sources: [{ dialogId: 'd-1', date: '2026-10-12' }],
    createdAt: '2026-10-12T10:00:00Z',
    updatedAt: '2026-10-12T10:00:00Z',
    lastConfirmedAt: null,
    expiresAt: null,
    confirmCount: 0,
    seenByUser: false,
    ...patch,
  }
}

function changes(
  status: MemoryChangesStatus,
  items: Array<{ op: MemoryChangeOp; fact: MemoryFactApiResponse }> = [],
): MemoryChangesApiResponse {
  return { status, reason: null, items }
}

const ok = <T>(data: T): ApiOutcome<T, string> => ({ ok: true, data })

afterEach(() => {
  vi.useRealTimers()
})

describe('лист согласия', () => {
  it('показывается, если согласия не было или оно на старый текст', () => {
    expect(needsMemoryConsent(null)).toBe(true)
    expect(needsMemoryConsent({ consentVersion: null })).toBe(true)
    expect(needsMemoryConsent({ consentVersion: '2020-01-01' })).toBe(true)
    expect(needsMemoryConsent({ consentVersion: MEMORY_CONSENT_VERSION })).toBe(false)
  })
})

describe('память в работе', () => {
  it('«Без памяти» предлагается, только когда память правда работает', () => {
    const on = { enabled: true, available: true }
    expect(memoryInUse(on)).toBe(true)
    expect(memoryInUse({ ...on, enabled: false })).toBe(false)
    expect(memoryInUse({ ...on, available: false })).toBe(false)
  })

  it('слово у строки в профиле', () => {
    expect(memorySectionStatus({ enabled: true, available: true })).toBe('включена')
    expect(memorySectionStatus({ enabled: false, available: true })).toBe('на паузе')
    expect(memorySectionStatus({ enabled: true, available: false })).toBe('недоступна')
  })
})

describe('пометка в журнале', () => {
  it('только у разговора «Без памяти»', () => {
    expect(dialogMemoryMark({ memoryMode: 'off' })?.label).toBe('Без памяти')
    expect(dialogMemoryMark({ memoryMode: 'on' })).toBeNull()
    expect(dialogMemoryMark({})).toBeNull()
  })
})

describe('экран «Память»: группы', () => {
  it('категории раскладываются по группам в порядке экрана, пустые группы не показываются', () => {
    const facts = [
      fact({ category: MemoryFactCategory.Interest }),
      fact({ category: MemoryFactCategory.Style }),
      fact({ category: MemoryFactCategory.Goal }),
      fact({ category: MemoryFactCategory.Situation }),
      fact({ category: MemoryFactCategory.Person }),
    ]
    const view = groupMemory(facts)
    expect(view.groups.map((group) => group.title)).toEqual([
      'Как со мной говорить',
      'Близкие',
      'Что сейчас',
      'Интересы',
    ])
    // situation and goal share one group, in the server's order.
    expect(view.groups[2]!.facts.map((item) => item.category)).toEqual([
      MemoryFactCategory.Goal,
      MemoryFactCategory.Situation,
    ])
    expect(view.count).toBe(5)
  })

  it('ждущие ответа — отдельно, предположения — последней группой, истёкшие не видны', () => {
    const proposed = fact({ category: MemoryFactCategory.Situation, status: MemoryFactStatus.Proposed })
    const guess = fact({ category: MemoryFactCategory.Works, status: MemoryFactStatus.Candidate })
    const pinned = fact({ category: MemoryFactCategory.Works, status: MemoryFactStatus.Pinned })
    const expired = fact({ category: MemoryFactCategory.Works, status: MemoryFactStatus.Expired })
    const view = groupMemory([proposed, guess, pinned, expired])
    expect(view.proposed).toEqual([proposed])
    expect(view.groups.map((group) => group.id)).toEqual(['helps', 'guesses'])
    expect(view.groups[0]!.facts).toEqual([pinned])
    expect(view.groups[1]!.facts).toEqual([guess])
    expect(view.count).toBe(3)
  })

  it('незнакомая категория (сервер новее клиента) видна в «Другое», а не пропадает', () => {
    const unknown = fact({ category: 'pet' as MemoryFactCategory })
    expect(groupMemory([unknown]).groups).toEqual([{ id: 'other', title: 'Другое', facts: [unknown] }])
  })

  it('пустая память — ни одной группы', () => {
    expect(groupMemory([])).toEqual({ proposed: [], groups: [], count: 0 })
  })
})

describe('откуда факт', () => {
  const now = new Date(2026, 9, 20)

  it('один разговор: «из разговора 12 окт.»', () => {
    expect(memoryFactSource(fact(), now)).toBe('из разговора 12 окт.')
  })

  it('несколько разговоров — число и последний день', () => {
    const sources = [
      { dialogId: 'a', date: '2026-10-03' },
      { dialogId: 'b', date: '2026-10-12' },
    ]
    expect(memoryFactSource(fact({ sources }), now)).toBe('из 2 разговоров, последний 12 окт.')
    const many = Array.from({ length: 21 }, (_, index) => ({ dialogId: `d${index}`, date: '2026-09-01' }))
    expect(memoryFactSource(fact({ sources: many }), now)).toBe('из 21 разговора, последний 1 сент.')
  })

  it('другой год — с годом', () => {
    const sources = [{ dialogId: 'a', date: '2025-12-31' }]
    expect(memoryFactSource(fact({ sources }), now)).toMatch(/^из разговора 31 дек\. 2025/)
  })

  it('записанное человеком без разговора — «записано тобой»; без источников вообще — пусто', () => {
    expect(memoryFactSource(fact({ sources: [], origin: MemoryFactOrigin.UserEdit }), now)).toBe(
      'записано тобой',
    )
    expect(memoryFactSource(fact({ sources: [] }), now)).toBe('')
  })
})

describe('действия с фактом', () => {
  it('по статусу', () => {
    expect(memoryFactActions(fact())).toEqual(['edit', 'pin', 'delete'])
    expect(memoryFactActions(fact({ status: MemoryFactStatus.Pinned }))).toEqual(['edit', 'unpin', 'delete'])
    expect(memoryFactActions(fact({ status: MemoryFactStatus.Proposed }))).toEqual(['accept', 'decline'])
    expect(memoryFactActions(fact({ status: MemoryFactStatus.Candidate }))).toEqual([
      'confirm',
      'edit',
      'delete',
    ])
    expect(memoryFactActions(fact({ status: MemoryFactStatus.Expired }))).toEqual([])
  })

  it('запросы PATCH', () => {
    expect(memoryFactChange('pin')).toEqual({ status: MemoryFactStatus.Pinned })
    expect(memoryFactChange('unpin')).toEqual({ status: MemoryFactStatus.Active })
    expect(memoryFactChange('accept')).toEqual({ status: MemoryFactStatus.Active })
    expect(memoryFactChange('confirm')).toEqual({ confirm: true })
  })

  it('правка: стиль и близкие — полями, остальное — текстом', () => {
    expect(memoryEditKind(MemoryFactCategory.Style)).toBe('style')
    expect(memoryEditKind(MemoryFactCategory.Person)).toBe('person')
    expect(memoryEditKind(MemoryFactCategory.Works)).toBe('text')
  })
})

describe('проверка правки', () => {
  it('текст: не пустой, не короче 8 и не длиннее предела категории', () => {
    expect(memoryTextProblem('  ', MemoryFactCategory.Works)).not.toBeNull()
    expect(memoryTextProblem('коротко', MemoryFactCategory.Works)).not.toBeNull()
    // The agent's minimum, from the contract: eight characters pass, seven do not.
    expect(memoryTextProblem('а'.repeat(InputLimit.MemoryFactMin), MemoryFactCategory.Works)).toBeNull()
    expect(
      memoryTextProblem('а'.repeat(InputLimit.MemoryFactMin - 1), MemoryFactCategory.Works),
    ).not.toBeNull()
    expect(memoryTextProblem('Помогают вечерние прогулки', MemoryFactCategory.Works)).toBeNull()
    expect(memoryTextProblem('а'.repeat(161), MemoryFactCategory.Works)).toBe('Не длиннее 160 знаков')
    expect(memoryTextProblem('а'.repeat(121), MemoryFactCategory.Boundary)).toBe('Не длиннее 120 знаков')
  })

  it('стиль: хотя бы одно поле, имя без цифр и ссылок', () => {
    expect(styleSlotsProblem({})).not.toBeNull()
    expect(styleSlotsProblem({ address: '   ' })).not.toBeNull()
    expect(styleSlotsProblem({ form: 'ty' })).toBeNull()
    expect(styleSlotsProblem({ address: 'Марина' })).toBeNull()
    expect(styleSlotsProblem({ address: 'Марина 2000' })).not.toBeNull()
    expect(styleSlotsProblem({ address: 'https://x.ru' })).not.toBeNull()
  })

  it('близкий человек: роль обязательна, имя одним словом с заглавной', () => {
    expect(personSlotsProblem({ name: 'Аня' })).toBe('Выбери, кто это')
    expect(personSlotsProblem({ role: 'сестра', name: 'Аня Петрова' })).not.toBeNull()
    expect(personSlotsProblem({ role: 'сестра', name: 'аня', note: 'поддерживает' })).toBeNull()
    expect(personSlotsProblem({ role: 'сестра', note: 'а'.repeat(61) })).not.toBeNull()
    expect(cleanPersonSlots({ role: ' Сестра ', name: 'аня', note: ' ' })).toEqual({
      role: 'сестра',
      name: 'Аня',
    })
  })
})

describe('форма «Исправить» / «Добавить»', () => {
  it('стиль и близкие уходят только полями, остальное — только текстом', () => {
    expect(
      memoryFactBody(MemoryFactCategory.Person, {
        text: 'лишнее',
        style: {},
        person: { role: 'сестра', name: 'аня' },
      }),
    ).toEqual({ body: { slots: { role: 'сестра', name: 'Аня' } } })
    expect(
      memoryFactBody(MemoryFactCategory.Style, { text: '', style: { form: 'ty', address: ' ' }, person: {} }),
    ).toEqual({ body: { slots: { form: 'ty' } } })
    expect(
      memoryFactBody(MemoryFactCategory.Works, {
        text: '  Помогают прогулки  ',
        style: { form: 'ty' },
        person: {},
      }),
    ).toEqual({ body: { text: 'Помогают прогулки' } })
  })

  it('у полей минимума нет: «на ты» и «мама» проходят', () => {
    expect(memoryFactBody(MemoryFactCategory.Style, { text: '', style: { form: 'ty' }, person: {} })).toEqual(
      {
        body: { slots: { form: 'ty' } },
      },
    )
    expect(
      memoryFactBody(MemoryFactCategory.Person, { text: '', style: {}, person: { role: 'мама' } }),
    ).toEqual({
      body: { slots: { role: 'мама' } },
    })
  })

  it('правка стиля шлёт весь набор полей: сервер заменяет слоты целиком', () => {
    const style = fact({
      category: MemoryFactCategory.Style,
      slots: { address: 'Марина', form: 'ty', advice: 'ask_first' },
    })
    const draft = memoryFactDraft(style)
    draft.style.length = 'short'
    expect(memoryFactBody(MemoryFactCategory.Style, draft)).toEqual({
      body: { slots: { address: 'Марина', form: 'ty', length: 'short', advice: 'ask_first' } },
    })
  })

  it('ошибка формы вместо запроса', () => {
    expect(memoryFactBody(MemoryFactCategory.Person, { text: '', style: {}, person: {} })).toEqual({
      problem: 'Выбери, кто это',
    })
    expect('problem' in memoryFactBody(MemoryFactCategory.Works, { text: 'да', style: {}, person: {} })).toBe(
      true,
    )
  })

  it('правка начинается с полей или текста факта', () => {
    const person = fact({
      category: MemoryFactCategory.Person,
      text: 'Сестра Аня',
      slots: { role: 'сестра', name: 'Аня' },
    })
    expect(memoryFactDraft(person)).toEqual({ text: '', style: {}, person: { role: 'сестра', name: 'Аня' } })
    expect(memoryFactDraft(fact({ text: 'Любит джаз' }))).toEqual({
      text: 'Любит джаз',
      style: {},
      person: {},
    })
    expect(memoryFactDraft(null)).toEqual({ text: '', style: {}, person: {} })
  })

  it('«как со мной говорить» добавляется, только пока его нет; пересказ не добавляется никогда', () => {
    expect(newMemoryFactCategories([])).toContain(MemoryFactCategory.Style)
    expect(newMemoryFactCategories([])).not.toContain(MemoryFactCategory.Recap)
    expect(newMemoryFactCategories([fact({ category: MemoryFactCategory.Style })])).not.toContain(
      MemoryFactCategory.Style,
    )
  })
})

describe('карточка «Я запомнил»: что показывать', () => {
  it('только ready и только новое: подтверждение уже известного — не новость', () => {
    const added = fact()
    const confirmed = fact()
    const ready = changes(MemoryChangesStatus.Ready, [
      { op: MemoryChangeOp.Add, fact: added },
      { op: MemoryChangeOp.Confirm, fact: confirmed },
    ])
    expect(memoryCardContent(ready).items.map((item) => item.fact)).toEqual([added])
    expect(shouldShowMemoryCard(ready)).toBe(true)
  })

  it('pending, skipped, пусто и null — карточки нет', () => {
    const one = [{ op: MemoryChangeOp.Add, fact: fact() }]
    expect(shouldShowMemoryCard(changes(MemoryChangesStatus.Pending, one))).toBe(false)
    expect(shouldShowMemoryCard(changes(MemoryChangesStatus.Skipped, one))).toBe(false)
    expect(shouldShowMemoryCard(changes(MemoryChangesStatus.Ready))).toBe(false)
    expect(shouldShowMemoryCard(null)).toBe(false)
  })

  it('предположения и истёкшие в карточку не идут, один факт — один пункт', () => {
    const active = fact()
    const ready = changes(MemoryChangesStatus.Ready, [
      { op: MemoryChangeOp.Add, fact: active },
      { op: MemoryChangeOp.Update, fact: active },
      { op: MemoryChangeOp.Add, fact: fact({ status: MemoryFactStatus.Candidate }) },
      { op: MemoryChangeOp.Supersede, fact: fact({ status: MemoryFactStatus.Expired }) },
    ])
    expect(memoryCardContent(ready).items.map((item) => item.fact.id)).toEqual([active.id])
  })

  it('ждущие «Запомнить» — первыми; не больше четырёх, остальное считается', () => {
    const plain = Array.from({ length: 4 }, () => ({ op: MemoryChangeOp.Add, fact: fact() }))
    const proposed = fact({ status: MemoryFactStatus.Proposed })
    const content = memoryCardContent(
      changes(MemoryChangesStatus.Ready, [...plain, { op: MemoryChangeOp.Add, fact: proposed }]),
    )
    expect(content.items).toHaveLength(MEMORY_CARD_MAX_ITEMS)
    expect(content.items[0]).toEqual({ fact: proposed, proposed: true })
    expect(content.more).toBe(1)
  })

  it('ждать ли карточку: не после разговора «Без памяти» и не при выключенной памяти', () => {
    expect(shouldWatchMemoryChanges({ memoryMode: 'on', memoryEnabled: true })).toBe(true)
    expect(shouldWatchMemoryChanges({ memoryMode: 'off', memoryEnabled: true })).toBe(false)
    expect(shouldWatchMemoryChanges({ memoryMode: 'on', memoryEnabled: false })).toBe(false)
    // An older gateway says nothing: one request finds out.
    expect(shouldWatchMemoryChanges({})).toBe(true)
  })
})

/** A clock that moves only when the poll waits, so the 30 seconds pass instantly. */
function fakeClock() {
  let time = 0
  const waits: number[] = []
  return {
    now: () => time,
    wait: async (ms: number) => {
      waits.push(ms)
      time += ms
    },
    waits,
  }
}

describe('опрос изменений после разговора', () => {
  it('каждые 3 с до ready', async () => {
    const clock = fakeClock()
    const ready = changes(MemoryChangesStatus.Ready, [{ op: MemoryChangeOp.Add, fact: fact() }])
    const load = vi
      .fn<() => Promise<ApiOutcome<MemoryChangesApiResponse, string>>>()
      .mockResolvedValueOnce(ok(changes(MemoryChangesStatus.Pending)))
      .mockResolvedValueOnce(ok(changes(MemoryChangesStatus.Pending)))
      .mockResolvedValueOnce(ok(ready))
    expect(await pollMemoryChanges(load, clock)).toEqual(ready)
    expect(load).toHaveBeenCalledTimes(3)
    expect(clock.waits).toEqual([3000, 3000])
  })

  it('pending до конца — null через 30 с, 11 запросов', async () => {
    const clock = fakeClock()
    const load = vi.fn(async () => ok(changes(MemoryChangesStatus.Pending)))
    expect(await pollMemoryChanges(load, clock)).toBeNull()
    expect(load).toHaveBeenCalledTimes(11)
    expect(clock.now()).toBe(30_000)
  })

  it('skipped — сразу null, без повторов', async () => {
    const clock = fakeClock()
    const load = vi.fn(async () => ok(changes(MemoryChangesStatus.Skipped)))
    expect(await pollMemoryChanges(load, clock)).toBeNull()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('отказ с кодом (чужой или неизвестный диалог) — null без повторов', async () => {
    const clock = fakeClock()
    const load = vi.fn(async (): Promise<ApiOutcome<MemoryChangesApiResponse, string>> => ({
      ok: false,
      code: 'DIALOG_NOT_FOUND',
    }))
    expect(await pollMemoryChanges(load, clock)).toBeNull()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('сбой запроса — спрашиваем снова, а не показываем ошибку', async () => {
    const clock = fakeClock()
    const ready = changes(MemoryChangesStatus.Ready, [{ op: MemoryChangeOp.Add, fact: fact() }])
    const load = vi
      .fn<() => Promise<ApiOutcome<MemoryChangesApiResponse, string>>>()
      .mockRejectedValueOnce(new Error('HTTP 503'))
      .mockResolvedValueOnce(ok(ready))
    expect(await pollMemoryChanges(load, clock)).toEqual(ready)
  })

  it('отмена прекращает опрос', async () => {
    const clock = fakeClock()
    const controller = new AbortController()
    const load = vi.fn(async () => {
      controller.abort()
      return ok(changes(MemoryChangesStatus.Ready, [{ op: MemoryChangeOp.Add, fact: fact() }]))
    })
    expect(await pollMemoryChanges(load, { ...clock, signal: controller.signal })).toBeNull()
  })
})

describe('карточка как состояние модуля', () => {
  const instant = { wait: async () => {} }
  type Load = (dialogId: string) => Promise<ApiOutcome<MemoryChangesApiResponse, string>>

  it('готовые изменения — карточка с владельцем; убрать последний пункт — карточки нет', async () => {
    const item = fact()
    const card = createMemoryCard(instant)
    const listener = vi.fn()
    card.subscribe(listener)
    await card.watch('d-1', 'user-a', async () =>
      ok(changes(MemoryChangesStatus.Ready, [{ op: MemoryChangeOp.Add, fact: item }])),
    )
    expect(card.getSnapshot()).toMatchObject({ dialogId: 'd-1', owner: 'user-a', items: [{ fact: item }] })
    expect(listener).toHaveBeenCalled()

    card.remove(item.id)
    expect(card.getSnapshot()).toBeNull()
  })

  it('skipped — карточки нет и ничего не сообщается', async () => {
    const card = createMemoryCard(instant)
    await card.watch('d-1', 'user-a', async () => ok(changes(MemoryChangesStatus.Skipped)))
    expect(card.getSnapshot()).toBeNull()
  })

  it('«Запомнить» на карточке: пункт остаётся, но больше не ждёт', async () => {
    const proposed = fact({ status: MemoryFactStatus.Proposed })
    const card = createMemoryCard(instant)
    await card.watch('d-1', 'user-a', async () =>
      ok(changes(MemoryChangesStatus.Ready, [{ op: MemoryChangeOp.Add, fact: proposed }])),
    )
    card.update({ ...proposed, status: MemoryFactStatus.Active })
    expect(card.getSnapshot()?.items).toEqual([
      { fact: { ...proposed, status: MemoryFactStatus.Active }, proposed: false },
    ])
  })

  it('выход из аккаунта во время опроса — ответ, пришедший позже, не показывается', async () => {
    let answer!: (value: ApiOutcome<MemoryChangesApiResponse, string>) => void
    const card = createMemoryCard(instant)
    const watching = card.watch('d-1', 'user-a', () => new Promise((resolve) => (answer = resolve)))
    card.reset()
    answer(ok(changes(MemoryChangesStatus.Ready, [{ op: MemoryChangeOp.Add, fact: fact() }])))
    await watching
    expect(card.getSnapshot()).toBeNull()
  })

  it('новый разговор заменяет карточку прежнего', async () => {
    const first = fact()
    const second = fact()
    const load: Load = async (dialogId) =>
      ok(
        changes(MemoryChangesStatus.Ready, [
          { op: MemoryChangeOp.Add, fact: dialogId === 'd-1' ? first : second },
        ]),
      )
    const card = createMemoryCard(instant)
    await card.watch('d-1', 'user-a', load)
    await card.watch('d-2', 'user-a', load)
    expect(card.getSnapshot()).toMatchObject({ dialogId: 'd-2', items: [{ fact: second }] })
  })
})

describe('«Забыть» с пятью секундами на «Вернуть»', () => {
  it('запрос уходит по истечении 5 с', async () => {
    vi.useFakeTimers()
    const forgets = createPendingForgets()
    const run = vi.fn()
    forgets.schedule('f-1', run)
    expect(forgets.has('f-1')).toBe(true)
    expect(forgets.getSnapshot().has('f-1')).toBe(true)

    await vi.advanceTimersByTimeAsync(FORGET_UNDO_MS - 1)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledOnce()
    expect(forgets.has('f-1')).toBe(false)
  })

  it('«Вернуть» вовремя — запроса нет', async () => {
    vi.useFakeTimers()
    const forgets = createPendingForgets()
    const run = vi.fn()
    forgets.schedule('f-1', run)
    await vi.advanceTimersByTimeAsync(3000)
    expect(forgets.undo('f-1')).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run).not.toHaveBeenCalled()
    // Too late: there is nothing left to take back.
    expect(forgets.undo('f-1')).toBe(false)
  })

  it('выход из аккаунта отменяет всё ещё не отправленное', async () => {
    vi.useFakeTimers()
    const forgets = createPendingForgets()
    const run = vi.fn()
    forgets.schedule('f-1', run)
    forgets.schedule('f-2', run)
    forgets.cancelAll()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run).not.toHaveBeenCalled()
    expect(forgets.getSnapshot().size).toBe(0)
  })

  it('сбой самого запроса не выходит наружу', async () => {
    vi.useFakeTimers()
    const forgets = createPendingForgets()
    forgets.schedule('f-1', () => Promise.reject(new Error('HTTP 503')))
    await vi.advanceTimersByTimeAsync(FORGET_UNDO_MS)
    expect(forgets.has('f-1')).toBe(false)
  })
})

describe('скачать мою память', () => {
  it('имя файла — по местному дню', () => {
    expect(memoryExportFileName(new Date(2026, 9, 2, 23, 59))).toBe('ryadom-memory-2026-10-02.json')
  })
})

// ─── notes: the sheet "Что помнит Рядом" ──────────────────────────────────────

import {
  MemoryInstructionApiErrorCode as InstructionErrors,
  MemoryNoteKind,
  type MemoryInstructionApiResponse,
  type MemoryNoteApiResponse,
} from '@ryadom/contracts/api/memory'
import {
  groupNotes,
  instructionResultText,
  MEMORY_INSTRUCTION_ERRORS,
  memorySwitches,
  noteDateLabel,
  replaceNote,
} from '../src/memory'

function note(overrides: Partial<MemoryNoteApiResponse> = {}): MemoryNoteApiResponse {
  return {
    id: 'n-1',
    kind: MemoryNoteKind.Situation,
    text: 'Работает в продажах',
    sensitive: false,
    eventDate: null,
    createdAt: '2026-10-12T10:00:00.000Z',
    updatedAt: '2026-10-12T10:00:00.000Z',
    dialogId: null,
    ...overrides,
  }
}

describe('заметки в листе «Что помнит Рядом»', () => {
  it('группы идут в порядке экрана, пустые не показываются, порядок внутри группы — как у сервера', () => {
    const view = groupNotes([
      note({ id: 'a', kind: MemoryNoteKind.Boundary, text: 'Не хочет обсуждать отца' }),
      note({ id: 'b', kind: MemoryNoteKind.Name, text: 'Зовут Алекс' }),
      note({ id: 'c', kind: MemoryNoteKind.Style, text: 'Просит на ты' }),
      note({ id: 'd', kind: MemoryNoteKind.Wellbeing, sensitive: true, text: 'Плохо спит' }),
    ])
    expect(view.count).toBe(4)
    expect(view.groups.map((g) => g.title)).toEqual([
      'Обо мне и как со мной говорить',
      'О чём не говорить',
      'Самочувствие',
    ])
    expect(view.groups[0]!.notes.map((n) => n.id)).toEqual(['b', 'c'])
  })

  it('неизвестный вид нового сервера всё равно виден — «Другое»', () => {
    const view = groupNotes([note({ id: 'x', kind: 'future_kind' as MemoryNoteKind })])
    expect(view.groups.map((g) => g.title)).toEqual(['Другое'])
  })

  it('дата заметки и дата события', () => {
    const now = new Date('2026-10-26T12:00:00Z')
    expect(noteDateLabel(note(), now)).toBe('12 окт.')
    expect(noteDateLabel(note({ eventDate: '2026-11-01' }), now)).toContain('событие')
  })

  it('ответ на «Скажи, что поправить»: что изменено; ничего; отказ правила — нейтрально, без причины', () => {
    const empty: MemoryInstructionApiResponse = { added: [], updated: [], deleted: [], blocked: [] }
    expect(instructionResultText({ ...empty, updated: [note()], deleted: ['x', 'y'] })).toBe('Изменено: 1, удалено: 2')
    expect(instructionResultText(empty)).toBe('Ничего не нашлось')
    const refused = instructionResultText({ ...empty, blocked: ['medication'] })
    expect(refused).toBe('Так запомнить не получится')
    expect(refused).not.toContain('medication')
  })

  it('тексты отказов поля правки есть на каждый код', () => {
    for (const code of Object.values(InstructionErrors)) expect(MEMORY_INSTRUCTION_ERRORS[code]).toBeTruthy()
  })

  it('переключатели чувствительного и поиска недоступны на паузе и без сервиса', () => {
    const on = { enabled: true, available: true, sensitiveEnabled: false, chatSearchEnabled: true }
    expect(memorySwitches(on)).toMatchObject({ memory: true, sensitive: false, chatSearch: true, sensitiveDisabled: false })
    expect(memorySwitches({ ...on, enabled: false })).toMatchObject({ sensitiveDisabled: true, chatSearchDisabled: true })
    expect(memorySwitches({ ...on, available: false }).sensitiveDisabled).toBe(true)
  })

  it('замена и удаление заметки в списке экрана', () => {
    const list = [note({ id: 'a' }), note({ id: 'b' })]
    expect(replaceNote(list, 'a', note({ id: 'a', text: 'Новый текст' }))[0]!.text).toBe('Новый текст')
    expect(replaceNote(list, 'a', null).map((n) => n.id)).toEqual(['b'])
  })
})

describe('«Запомнил: … · Убрать» и лист «Рядом теперь запоминает важное»', () => {
  it('новые чувствительные заметки — только новые и только чувствительные', async () => {
    const { newSensitiveNotes, noteIds } = await import('../src/memory')
    const start = [note({ id: 'old', sensitive: true, kind: MemoryNoteKind.Wellbeing })]
    const known = noteIds(start)
    const later = [
      ...start,
      note({ id: 'plain', text: 'Работает в продажах' }),
      note({ id: 'fresh', sensitive: true, kind: MemoryNoteKind.Wellbeing, text: 'Плохо спит' }),
    ]
    expect(newSensitiveNotes(known, later).map((n) => n.id)).toEqual(['fresh'])
    known.add('fresh')
    expect(newSensitiveNotes(known, later)).toEqual([])
  })

  it('лист-приглашение: один раз, тому, кто ещё не решал; согласие и «Не сейчас» его снимают', async () => {
    const { shouldInviteToMemory } = await import('../src/memory')
    const fresh = { available: true, enabled: false, consentVersion: null }
    expect(shouldInviteToMemory(fresh, false, true)).toBe(true)
    expect(shouldInviteToMemory(fresh, true, true)).toBe(false) // «Не сейчас»
    expect(shouldInviteToMemory({ ...fresh, consentVersion: '2026-10-12' }, false, true)).toBe(false) // уже давал согласие (и выключил)
    expect(shouldInviteToMemory({ ...fresh, enabled: true }, false, true)).toBe(false)
    expect(shouldInviteToMemory({ ...fresh, available: false }, false, true)).toBe(false)
    expect(shouldInviteToMemory(null, false, true)).toBe(false)
    expect(shouldInviteToMemory(fresh, false)).toBe(false) // по умолчанию лист выключен до решения владельца (0.1)
  })
})
