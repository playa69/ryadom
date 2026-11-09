'use client'

import { useEffect, useState } from 'react'
import { Button } from '@ryadom/ui/components/button'
import { ConsentCheckbox, ConsentNotice } from '@/app/(auth)/_components/consent-group'
import { PRIMARY_BUTTON } from '@/app/(auth)/_components/parts'
import { useAuth } from '@/lib/auth'
import Breathing from './Breathing'

function partOfDay(): string {
  const hour = new Date().getHours()
  return hour < 5 ? 'Поздний вечер' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер'
}

/**
 * The consent door before the chat. A signed-in account records the current terms through the API;
 * a newcomer only opens the active home, where the first conversation will create the account.
 */
export default function TermsGate({
  termsUrl,
  consentUrl,
  onContinue,
}: {
  termsUrl: string
  consentUrl: string
  onContinue?: () => void
}) {
  const { acceptConsents } = useAuth()
  const [consented, setConsented] = useState(false)
  const [loading, setLoading] = useState(false)
  const [problem, setProblem] = useState('')
  // Computed in the browser only: the server's clock and time zone are not the person's.
  const [hello, setHello] = useState('')
  useEffect(() => setHello(partOfDay()), [])

  async function agree() {
    if (loading || !consented) return
    if (onContinue) {
      onContinue()
      return
    }
    setProblem('')
    setLoading(true)
    // On success the shell sees the recorded version and opens the page.
    if (!(await acceptConsents())) {
      setProblem('Не получилось сохранить согласие. Попробуй ещё раз')
      setLoading(false)
    }
  }

  return (
    <main
      className="flex min-h-dvh flex-col items-center justify-center gap-4 px-[max(1rem,env(safe-area-inset-left,0px))] py-8 text-center"
      data-testid="terms-gate"
    >
      <Breathing className="w-24 tab:w-28 short:w-16" />
      <h1 className="min-h-[1.25em] text-2xl leading-tight font-bold tracking-display-tight text-foreground tab:text-3xl">
        {hello}
      </h1>
      <p className="max-w-xl text-base leading-[1.55] text-dim text-balance tab:text-lg">
        Один раз подтверди, что согласен(на), — и можно говорить.
      </p>
      <ConsentCheckbox
        checked={consented}
        onCheckedChange={setConsented}
        termsUrl={termsUrl}
        consentUrl={consentUrl}
        className="w-full max-w-md"
      />
      <div className="w-full max-w-md">
        <Button
          type="button"
          className={PRIMARY_BUTTON}
          aria-busy={loading || undefined}
          disabled={loading || !consented}
          onClick={() => void agree()}
          data-testid="welcome-continue"
        >
          Продолжить
        </Button>
      </div>
      {problem && (
        <p className="max-w-[40ch] text-base leading-snug text-danger" role="alert" data-testid="form-error">
          {problem}
        </p>
      )}
      <ConsentNotice termsUrl={termsUrl} consentUrl={consentUrl} className="max-w-2xl" />
      <p className="text-xs leading-normal text-dim">В опасной ситуации звони 112.</p>
    </main>
  )
}
