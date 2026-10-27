import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOSE_SPREAD_MS, DRAIN_MS, HARD_EXIT_MS, QUICK_EXIT_MS, createShutdown } from '../src/lib/shutdown'

/** The steps of a stop, recording when each ran (in ms since the signal). */
function steps() {
  const started = Date.now()
  const at = () => Date.now() - started
  const log: Array<[string, number, unknown?]> = []
  return {
    log,
    steps: {
      startDraining: () => log.push(['draining', at()]),
      stopTakingJobs: () => log.push(['jobs-stop-taking', at()]),
      closeSessions: (spread: number) => log.push(['sessions', at(), spread]),
      closeServer: (done: () => void) => {
        log.push(['server', at()])
        done()
      },
      finish: () => log.push(['finish', at()]),
      forceExit: () => log.push(['exit', at()]),
      log: (signal: string, graceful: boolean) => log.push(['signal', at(), `${signal}:${graceful}`]),
    },
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('останов пода', () => {
  it('SIGTERM: сначала проба, воркеры очереди перестают брать задачи, через паузу диалоги закрываются с разбросом', async () => {
    const { log, steps: s } = steps()
    createShutdown(s)('SIGTERM')

    // From the first moment: draining and the workers of the job queue stop taking jobs, nothing is closed yet.
    expect(log.map(([name]) => name)).toEqual(['signal', 'draining', 'jobs-stop-taking'])
    await vi.advanceTimersByTimeAsync(DRAIN_MS - 1)
    expect(log.map(([name]) => name)).toEqual(['signal', 'draining', 'jobs-stop-taking'])

    await vi.advanceTimersByTimeAsync(1)
    // `finish` waits for the running jobs, then closes the pools: it comes after the server is closed.
    expect(log.map(([name]) => name)).toEqual([
      'signal',
      'draining',
      'jobs-stop-taking',
      'sessions',
      'server',
      'finish',
    ])
    expect(log.find(([name]) => name === 'jobs-stop-taking')?.[1]).toBe(0)
    expect(log.find(([name]) => name === 'sessions')).toEqual(['sessions', DRAIN_MS, CLOSE_SPREAD_MS])
  })

  it('SIGTERM: зависший запрос не держит процесс дольше принудительного срока, который помещается в 60 секунд', async () => {
    const { log, steps: s } = steps()
    s.closeServer = () => log.push(['server', 0]) // a request that never ends: `done` is never called
    createShutdown(s)('SIGTERM')

    await vi.advanceTimersByTimeAsync(HARD_EXIT_MS - 1)
    expect(log.some(([name]) => name === 'exit')).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(log.find(([name]) => name === 'exit')?.[1]).toBe(HARD_EXIT_MS)
    // terminationGracePeriodSeconds of the api is 60; the cap leaves room for the kill signal to arrive.
    expect(HARD_EXIT_MS).toBe(30_000)
    expect(HARD_EXIT_MS).toBeLessThan(60_000)
    // The drain, the server's close (at most the cap) and the jobs' wait all start before the cap.
    expect(DRAIN_MS + CLOSE_SPREAD_MS).toBeLessThan(HARD_EXIT_MS)
  })

  it('SIGINT (Ctrl+C в разработке): без ожидания и без разброса', async () => {
    const { log, steps: s } = steps()
    createShutdown(s)('SIGINT')

    await vi.advanceTimersByTimeAsync(0)
    expect(log.find(([name]) => name === 'sessions')).toEqual(['sessions', 0, 0])
    expect(log.some(([name]) => name === 'jobs-stop-taking')).toBe(true)
    expect(log.some(([name]) => name === 'finish')).toBe(true)
    expect(QUICK_EXIT_MS).toBeGreaterThan(0)
  })

  it('повторный сигнал ничего не запускает второй раз', async () => {
    const { log, steps: s } = steps()
    const stop = createShutdown(s)
    stop('SIGTERM')
    stop('SIGTERM')
    stop('SIGINT')
    await vi.advanceTimersByTimeAsync(DRAIN_MS)
    expect(log.filter(([name]) => name === 'draining')).toHaveLength(1)
    expect(log.filter(([name]) => name === 'jobs-stop-taking')).toHaveLength(1)
    expect(log.filter(([name]) => name === 'sessions')).toHaveLength(1)
  })
})
