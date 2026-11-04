'use client'

import { Send, Smartphone } from 'lucide-react'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { Notice } from '@/components/notice'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { sendNotification } from '../actions'
import { INITIAL_NOTIFICATION_FORM_STATE, type NotificationDeviceView } from '../shared'

interface Props {
  userId: string
  devices: NotificationDeviceView[]
  titleMaxLength: number
  bodyMaxLength: number
}

function Submit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending}>
      <Send />
      {pending ? 'Секунду…' : 'Отправить'}
    </Button>
  )
}

function FieldError({ id, children }: { id: string; children?: string }) {
  if (!children) return null
  return (
    <p id={id} className="text-xs text-red-700">
      {children}
    </p>
  )
}

/**
 * The person's devices with notifications on and a message to all of them. What was typed survives a failure (the
 * form takes it back from the action's state); after a success the form is empty again.
 */
export default function SendNotification({ userId, devices, titleMaxLength, bodyMaxLength }: Props) {
  const [state, action] = useActionState(sendNotification, INITIAL_NOTIFICATION_FORM_STATE)
  const { fieldErrors, values } = state

  return (
    <div className="space-y-4">
      {devices.length === 0 ? (
        <p className="text-gray-600" data-testid="push-devices-none">
          Нет устройств с включёнными уведомлениями.
        </p>
      ) : (
        <ul className="divide-y divide-gray-200" data-testid="push-devices">
          {devices.map((device) => (
            <li
              key={device.id}
              className="flex items-start gap-2 py-2 first:pt-0 last:pb-0"
              data-testid="push-device"
            >
              <Smartphone className="mt-0.5 size-4 shrink-0 text-gray-500" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-sm font-medium break-words text-gray-900">{device.label}</p>
                <p className="text-xs text-gray-600">Подписка обновлена: {device.updatedAt}</p>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form action={action} className="space-y-3" data-testid="push-form">
        <input type="hidden" name="userId" value={userId} />
        <div className="space-y-1.5">
          <Label htmlFor="push-title">Заголовок</Label>
          <Input
            id="push-title"
            name="title"
            maxLength={titleMaxLength}
            defaultValue={values.title}
            aria-invalid={Boolean(fieldErrors.title)}
            aria-describedby={fieldErrors.title ? 'push-title-error' : undefined}
            className="bg-white"
          />
          <FieldError id="push-title-error">{fieldErrors.title}</FieldError>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="push-body">Текст</Label>
          <textarea
            id="push-body"
            name="body"
            rows={4}
            maxLength={bodyMaxLength}
            defaultValue={values.body}
            aria-invalid={Boolean(fieldErrors.body)}
            aria-describedby={cn('push-body-hint', fieldErrors.body && 'push-body-error')}
            className="w-full min-w-0 rounded-md border border-input bg-white px-2.5 py-2 text-base shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm"
          />
          <FieldError id="push-body-error">{fieldErrors.body}</FieldError>
          <p id="push-body-hint" className="text-xs text-gray-600">
            Текст видно на экране блокировки: без личного. Заголовок до {titleMaxLength} символов, текст до{' '}
            {bodyMaxLength}.
          </p>
        </div>
        {state.error && <Notice tone="error">{state.error}</Notice>}
        {state.ok && <Notice tone="success">{state.ok}</Notice>}
        <Submit />
      </form>
    </div>
  )
}
