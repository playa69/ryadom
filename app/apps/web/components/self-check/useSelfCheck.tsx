'use client'

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import type { SelfCheckFrom } from '@ryadom/analytics/events'
import type { SelfCheckTest } from '@ryadom/self-check/types'
import TestSheet from './TestSheet'

interface Api {
  start(test: SelfCheckTest, from: SelfCheckFrom): void
}

const Ctx = createContext<Api | null>(null)

/** One sheet for every list of tests: the diary block and the catalog open the same pass. */
export function SelfCheckProvider({ children }: { children: ReactNode }) {
  const [pass, setPass] = useState<{ test: SelfCheckTest; from: SelfCheckFrom } | null>(null)
  const start = useCallback((test: SelfCheckTest, from: SelfCheckFrom) => setPass({ test, from }), [])
  const api = useMemo(() => ({ start }), [start])
  return (
    <Ctx.Provider value={api}>
      {children}
      {pass && <TestSheet key={pass.test.id} test={pass.test} from={pass.from} onClose={() => setPass(null)} />}
    </Ctx.Provider>
  )
}

export function useSelfCheck(): Api {
  const api = useContext(Ctx)
  if (!api) throw new Error('useSelfCheck outside SelfCheckProvider')
  return api
}
