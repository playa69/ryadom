'use client'

import { Mail, Shield, ShieldOff } from 'lucide-react'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { Notice } from '@/components/notice'
import { Button } from '@/components/ui/button'
import { confirmEmail, toggleActivation } from '../actions'
import { INITIAL_USER_ACTION_STATE } from '../shared'

interface Props {
  userId: string
  isActive: boolean
  isDeleted: boolean
  isEmailConfirmed: boolean
}

function Submit({
  children,
  variant,
  icon,
}: {
  children: string
  variant: 'default' | 'destructive' | 'outline'
  icon: React.ReactNode
}) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant={variant} disabled={pending}>
      {icon}
      {pending ? 'Секунду…' : children}
    </Button>
  )
}

export default function UserActions({ userId, isActive, isDeleted, isEmailConfirmed }: Props) {
  const [toggleState, toggleAction] = useActionState(toggleActivation, INITIAL_USER_ACTION_STATE)
  const [confirmState, confirmAction] = useActionState(confirmEmail, INITIAL_USER_ACTION_STATE)

  if (isDeleted) {
    return (
      <p className="text-gray-600">
        Аккаунт удалён: действия недоступны. Персональные данные стёрты, восстановить их нельзя.
      </p>
    )
  }

  const state = [toggleState, confirmState].find((item) => item.ok || item.error)

  return (
    <>
      {state?.error && <Notice tone="error">{state.error}</Notice>}
      {state?.ok && <Notice tone="success">{state.ok}</Notice>}

      <div className="flex flex-wrap gap-2">
        <form action={toggleAction}>
          <input type="hidden" name="userId" value={userId} />
          <Submit variant={isActive ? 'destructive' : 'default'} icon={isActive ? <ShieldOff /> : <Shield />}>
            {isActive ? 'Заблокировать' : 'Разблокировать'}
          </Submit>
        </form>

        {!isEmailConfirmed && (
          <form action={confirmAction}>
            <input type="hidden" name="userId" value={userId} />
            <Submit variant="outline" icon={<Mail />}>
              Подтвердить почту вручную
            </Submit>
          </form>
        )}
      </div>
    </>
  )
}
