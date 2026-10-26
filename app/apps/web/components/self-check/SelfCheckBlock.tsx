'use client'

import { Card } from '@ryadom/ui/components/card'
import { Button } from '@ryadom/ui/components/button'
import { shownWave1 } from '@/lib/self-check'
import { BUTTON } from '../controls'
import { lengthLine } from './ui'
import { useSelfCheck } from './useSelfCheck'

/** The block «Самопроверка» in the segment «Дневник»: the six scales of wave 1. */
export default function SelfCheckBlock() {
  const { start } = useSelfCheck()
  const tests = shownWave1()
  if (tests.length === 0) return null
  return (
    <Card className="gap-1 rounded-lg px-5 py-5 shadow-none" data-testid="self-check-block">
      <h2 className="text-lg font-semibold text-foreground">Самопроверка</h2>
      <p className="mb-2 text-sm text-dim">Научные скрининговые опросники. Это не диагноз — только ориентир.</p>
      <ul className="divide-y divide-line">
        {tests.map((t) => (
          <li key={t.id} className="flex items-center gap-3 py-3" data-testid={`self-check-row-${t.id}`}>
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-foreground">{t.title}</div>
              <div className="text-sm text-dim">{lengthLine(t)}</div>
            </div>
            <Button variant="outline" className={BUTTON} onClick={() => start(t, 'diary')} data-testid={`self-check-start-${t.id}`}>
              Пройти
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  )
}
