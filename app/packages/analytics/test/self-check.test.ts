import type { PostHog } from 'posthog-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalyticsConfigApiResponse } from '@ryadom/contracts/api/analytics'
import { resetAnalyticsForTests, startAnalytics, track } from '../src/browser'
import { AnalyticsEvent, type AnalyticsEventProperties } from '../src/events'
import { reportSelfCheckOpened, scheduleSelfCheckSearchReport, SEARCH_SETTLE_MS } from '../src/self-check'

/** The reports of the tests (REQ-WELL-06): where a list was opened, whether a search found anything, no score, level, answer or word. */

const CONFIG: AnalyticsConfigApiResponse = {
  enabled: true,
  key: 'phc_test',
  uiHost: 'https://eu.posthog.com',
  environment: 'local',
  features: {
    sessionReplay: false,
    clickCapture: true,
    heatmapCapture: false,
    errorTracking: true,
    webVitals: true,
    featureFlags: false,
    autocapture: false,
    heatmaps: false,
  },
}

async function startWithSpy() {
  const posthog = {
    init: vi.fn(),
    register: vi.fn(),
    capture: vi.fn(),
    identify: vi.fn(),
    reset: vi.fn(),
    captureException: vi.fn(),
    opt_out_capturing: vi.fn(),
    opt_in_capturing: vi.fn(),
  }
  await startAnalytics({
    apiBase: 'https://api.test',
    platform: 'web',
    appVersion: '1.2.3',
    fetch: (async () =>
      new Response(JSON.stringify({ status: true, result: CONFIG }))) as unknown as typeof fetch,
    loadSdk: async () => posthog as unknown as PostHog,
  })
  return posthog
}

beforeEach(() => {
  resetAnalyticsForTests()
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  })
  vi.stubGlobal('location', { origin: 'https://app.test', pathname: '/diary' })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('self_check_opened', () => {
  it('говорит, откуда открыт список: блок «Дневника», сегмент «Тесты», экран теста', async () => {
    const posthog = await startWithSpy()
    reportSelfCheckOpened('diary')
    reportSelfCheckOpened('tests')
    reportSelfCheckOpened('history')
    expect(posthog.capture.mock.calls).toEqual([
      ['self_check_opened', { from: 'diary' }],
      ['self_check_opened', { from: 'tests' }],
      ['self_check_opened', { from: 'history' }],
    ])
  })
})

describe('self_check_searched', () => {
  it('уходит после паузы в наборе один раз и несёт только «нашлось ли»', async () => {
    const posthog = await startWithSpy()
    vi.useFakeTimers()
    scheduleSelfCheckSearchReport(true, false)
    vi.advanceTimersByTime(SEARCH_SETTLE_MS - 1)
    expect(posthog.capture).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(posthog.capture.mock.calls).toEqual([['self_check_searched', { found: false }]])
    vi.advanceTimersByTime(SEARCH_SETTLE_MS * 3)
    expect(posthog.capture).toHaveBeenCalledTimes(1)
  })

  it('набор продолжается: прежний отчёт отменён, уходит только последний', async () => {
    const posthog = await startWithSpy()
    vi.useFakeTimers()
    const cancelFirst = scheduleSelfCheckSearchReport(true, true)
    vi.advanceTimersByTime(SEARCH_SETTLE_MS - 100)
    cancelFirst()
    scheduleSelfCheckSearchReport(true, false)
    vi.advanceTimersByTime(SEARCH_SETTLE_MS)
    expect(posthog.capture.mock.calls).toEqual([['self_check_searched', { found: false }]])
  })

  it('пустое поле поиском не считается, уход с экрана отменяет отчёт', async () => {
    const posthog = await startWithSpy()
    vi.useFakeTimers()
    scheduleSelfCheckSearchReport(false, true)
    const cancel = scheduleSelfCheckSearchReport(true, true)
    cancel()
    vi.advanceTimersByTime(SEARCH_SETTLE_MS * 2)
    expect(posthog.capture).not.toHaveBeenCalled()
  })
})

describe('события тестов не несут баллов, уровней, ответов и слов запроса', () => {
  /** What each event of the catalog carries; everything else a call site adds by mistake is cut before it leaves. */
  const allowed: Record<string, object> = {
    [AnalyticsEvent.SelfCheckOpened]: {
      from: 'tests',
    } satisfies AnalyticsEventProperties[AnalyticsEvent.SelfCheckOpened],
    [AnalyticsEvent.SelfCheckSearched]: {
      found: true,
    } satisfies AnalyticsEventProperties[AnalyticsEvent.SelfCheckSearched],
    [AnalyticsEvent.SelfCheckStarted]: {
      test_id: 'phq9',
      from: 'diary',
    } satisfies AnalyticsEventProperties[AnalyticsEvent.SelfCheckStarted],
    [AnalyticsEvent.SelfCheckStepBack]: {
      test_id: 'phq9',
    } satisfies AnalyticsEventProperties[AnalyticsEvent.SelfCheckStepBack],
    [AnalyticsEvent.SelfCheckInterruptChoice]: {
      test_id: 'phq9',
      action: 'abort',
      progress: 'second_third',
    } satisfies AnalyticsEventProperties[AnalyticsEvent.SelfCheckInterruptChoice],
    [AnalyticsEvent.SelfCheckCompleted]: {
      test_id: 'phq9',
    } satisfies AnalyticsEventProperties[AnalyticsEvent.SelfCheckCompleted],
    [AnalyticsEvent.SelfCheckResultAction]: {
      test_id: 'phq9',
      action: 'save',
    } satisfies AnalyticsEventProperties[AnalyticsEvent.SelfCheckResultAction],
    [AnalyticsEvent.SelfCheckConsentShown]: {},
    [AnalyticsEvent.SelfCheckConsentChoice]: {
      action: 'accepted',
    } satisfies AnalyticsEventProperties[AnalyticsEvent.SelfCheckConsentChoice],
    [AnalyticsEvent.SelfCheckSaveFailed]: {
      test_id: 'phq9',
    } satisfies AnalyticsEventProperties[AnalyticsEvent.SelfCheckSaveFailed],
    [AnalyticsEvent.SelfCheckHistoryOpened]: {
      test_id: 'phq9',
    } satisfies AnalyticsEventProperties[AnalyticsEvent.SelfCheckHistoryOpened],
    [AnalyticsEvent.SelfCheckWarningChoice]: {
      test_id: 'phq9',
      action: 'start',
    } satisfies AnalyticsEventProperties[AnalyticsEvent.SelfCheckWarningChoice],
    [AnalyticsEvent.SelfCheckSaved]: {
      test_id: 'phq9',
    } satisfies AnalyticsEventProperties[AnalyticsEvent.SelfCheckSaved],
    [AnalyticsEvent.SelfCheckResultDeleted]: {
      scope: 'all',
    } satisfies AnalyticsEventProperties[AnalyticsEvent.SelfCheckResultDeleted],
    [AnalyticsEvent.SelfCheckConsentRevoked]: {},
  }

  it('в проверке перечислены все события тестов каталога', () => {
    const inCatalog = Object.values(AnalyticsEvent).filter((name) => name.startsWith('self_check_'))
    expect(Object.keys(allowed).sort()).toEqual([...inCatalog].sort())
  })

  it('что бы вызов ни добавил, наружу уходит только заявленное', async () => {
    const posthog = await startWithSpy()
    const extras = {
      score: 20,
      subscores: [1, 2],
      band: 'high',
      answers: [3, 3],
      query: 'тревога',
      search: 'тревога',
      text: 'ответ',
    }
    for (const [event, properties] of Object.entries(allowed)) {
      track(event as AnalyticsEvent.SelfCheckOpened, { ...properties, ...extras } as never)
    }
    expect(posthog.capture.mock.calls).toEqual(
      Object.entries(allowed).map(([event, properties]) => [event, properties]),
    )
  })
})
