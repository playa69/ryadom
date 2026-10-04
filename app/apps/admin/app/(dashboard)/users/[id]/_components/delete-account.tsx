'use client'

import { UserX } from 'lucide-react'
import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { Notice } from '@/components/notice'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { deleteAccount } from '../actions'
import { INITIAL_USER_ACTION_STATE } from '../shared'

function ConfirmButton({ enabled }: { enabled: boolean }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="destructive" disabled={!enabled || pending}>
      {pending ? 'Секунду…' : 'Удалить навсегда'}
    </Button>
  )
}

/**
 * Lives inside the dialog content, which Radix unmounts on close, so every opening starts with
 * an empty field and without the previous attempt's error.
 */
function DeleteForm({ userId, email }: { userId: string; email: string }) {
  const [state, action] = useActionState(deleteAccount, INITIAL_USER_ACTION_STATE)
  const [typed, setTyped] = useState('')
  // Only a convenience: the action compares the address again on the server.
  const matches = typed.trim().toLowerCase() === email.trim().toLowerCase()

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="email" value={email} />
      <div className="space-y-2">
        <Label htmlFor="confirmEmail">Почта пользователя</Label>
        <Input
          id="confirmEmail"
          name="confirmEmail"
          autoComplete="off"
          placeholder={email}
          required
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
      </div>
      {state.error && <Notice tone="error">{state.error}</Notice>}
      <AlertDialogFooter>
        <AlertDialogCancel>Отмена</AlertDialogCancel>
        <ConfirmButton enabled={matches} />
      </AlertDialogFooter>
    </form>
  )
}

export default function DeleteAccount({ userId, email }: { userId: string; email: string }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="outline"
          className="self-start border-red-200 text-red-700 hover:bg-red-50 hover:text-red-700"
        >
          <UserX />
          Удалить аккаунт
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Удалить аккаунт?</AlertDialogTitle>
          <AlertDialogDescription>
            Аккаунт и все разговоры стираются без возможности восстановления, включая данные на
            стороне сервиса диалогов. Для подтверждения введите почту пользователя.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <DeleteForm userId={userId} email={email} />
      </AlertDialogContent>
    </AlertDialog>
  )
}
