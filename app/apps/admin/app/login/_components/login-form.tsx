'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { Notice } from '@/components/notice'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { confirmCode, requestCode } from '../actions'
import { INITIAL_LOGIN_STATE, type LoginFormState } from '../shared'

function SubmitButton({ children }: { children: string }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" className="h-11 w-full text-sm" disabled={pending}>
      {pending ? 'Секунду…' : children}
    </Button>
  )
}

function EmailStep({ state, action }: { state: LoginFormState; action: (fd: FormData) => void }) {
  return (
    <form action={action} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">Рабочая почта</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          autoFocus
          defaultValue={state.email}
          className="h-10 bg-white"
        />
      </div>
      {state.error && <Notice tone="error">{state.error}</Notice>}
      <SubmitButton>Прислать код</SubmitButton>
      <p className="text-center text-xs text-gray-500">
        Код придёт только на адрес из списка администраторов. Ответ одинаковый для любой почты.
      </p>
    </form>
  )
}

function CodeStep({ state, action }: { state: LoginFormState; action: (fd: FormData) => void }) {
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="email" value={state.email} />
      <div className="space-y-2">
        <Label htmlFor="code" className="block leading-snug">
          Код из письма на <span className="break-all">{state.email}</span>
        </Label>
        <Input
          id="code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          pattern="[0-9]{6}"
          required
          autoFocus
          className="h-11 bg-white text-center font-mono text-lg tracking-[0.4em]"
        />
      </div>
      {state.error && <Notice tone="error">{state.error}</Notice>}
      <SubmitButton>Войти</SubmitButton>
      <p className="text-center text-xs text-gray-500">
        Код действует 10 минут. Пять неверных попыток — и нужен новый.
      </p>
    </form>
  )
}

/**
 * Two steps in one form. Which step is shown comes from the action's state, so a wrong code
 * never loses the entered address.
 */
export default function LoginForm() {
  const [requestState, requestAction] = useActionState(requestCode, INITIAL_LOGIN_STATE)
  const [confirmState, confirmAction] = useActionState(confirmCode, requestState)

  // Requesting a code resets the second step, so the request state wins right after step one.
  const state = confirmState.email === requestState.email && requestState.step === 'code' ? confirmState : requestState

  if (state.step === 'code') {
    return (
      <>
        <CodeStep state={state} action={confirmAction} />
        <form action={requestAction} className="mt-4 text-center">
          <input type="hidden" name="email" value={state.email} />
          <button
            type="submit"
            className="rounded-sm text-sm text-blue-600 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            Прислать код ещё раз
          </button>
        </form>
      </>
    )
  }
  return <EmailStep state={state} action={requestAction} />
}
