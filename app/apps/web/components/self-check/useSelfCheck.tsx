'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { SelfCheckFrom } from '@ryadom/analytics/events'
import type { SavedResult } from '@ryadom/self-check/history'
import type { SelfCheckTest } from '@ryadom/self-check/types'
import { useAuth, useClient } from '@/lib/auth'
import HistorySheet from './HistorySheet'
import TestSheet from './TestSheet'

interface Api {
  start(test: SelfCheckTest, from: SelfCheckFrom): void
  openHistory(test: SelfCheckTest): void
  /** The newest saved result of every test, by test id; empty until the first read and after a failed one. */
  latest: Record<string, SavedResult>
  /** Read the newest results again (after saving or deleting). */
  refresh(): void
}

const Ctx = createContext<Api | null>(null)

/** One sheet for every list of tests, one history sheet, and the newest saved results the lists show. */
export function SelfCheckProvider({ children }: { children: ReactNode }) {
  const client = useClient()
  const { user } = useAuth()
  const [pass, setPass] = useState<{ test: SelfCheckTest; from: SelfCheckFrom } | null>(null)
  const [history, setHistory] = useState<SelfCheckTest | null>(null)
  const [latest, setLatest] = useState<Record<string, SavedResult>>({})

  const refresh = useCallback(() => {
    client
      .latestSelfCheckResults()
      .then((r) => setLatest(Object.fromEntries(r.items.map((i) => [i.testId, i]))))
      .catch(() => undefined)
  }, [client])
  useEffect(() => {
    if (user) refresh()
  }, [user, refresh])

  const api = useMemo<Api>(
    () => ({
      start: (test, from) => setPass({ test, from }),
      openHistory: setHistory,
      latest,
      refresh,
    }),
    [latest, refresh],
  )
  return (
    <Ctx.Provider value={api}>
      {children}
      {pass && <TestSheet key={pass.test.id} test={pass.test} from={pass.from} onClose={() => setPass(null)} />}
      {history && <HistorySheet key={history.id} test={history} onClose={() => setHistory(null)} />}
    </Ctx.Provider>
  )
}

export function useSelfCheck(): Api {
  const api = useContext(Ctx)
  if (!api) throw new Error('useSelfCheck outside SelfCheckProvider')
  return api
}
