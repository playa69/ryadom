'use client'

import { Copy, Link2, Send, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { DialogApiErrorCode } from '@ryadom/contracts/api/dialogs'
import {
  DIALOG_SHARE_DEFAULT_TTL_HOURS,
  DIALOG_SHARE_TTL_HOURS,
  DialogShareApiErrorCode,
  type DialogShareApiResponse,
  type DialogShareTtlHours,
} from '@ryadom/contracts/api/dialog-shares'
import { apiErrorText, codeText } from '@ryadom/client-core/errors'
import { Button } from '@ryadom/ui/components/button'
import { Spinner } from '@ryadom/ui/components/spinner'
import { cn } from '@ryadom/ui/lib/utils'
import { useClient } from '@/lib/auth'
import { shareExpiryText, shareViewsText } from '@/lib/dialog-share'
import { BUTTON } from './controls'
import Modal from './Modal'
import { useNotice } from './Notice'

const TTL_LABEL: Record<DialogShareTtlHours, string> = { 24: '24 часа', 72: '3 дня', 168: '7 дней' }

const CREATE_ERROR_TEXT: Record<DialogApiErrorCode | DialogShareApiErrorCode, string> = {
  [DialogApiErrorCode.DIALOG_NOT_FOUND]: 'Этот разговор не найден',
  [DialogApiErrorCode.USER_NOT_FOUND]: 'Аккаунт недоступен',
  [DialogApiErrorCode.USER_INACTIVE]: 'Аккаунт недоступен',
  [DialogShareApiErrorCode.SHARE_EXISTS]: 'У этого разговора уже есть ссылка',
  [DialogShareApiErrorCode.SHARE_LIMIT]: 'Активных ссылок уже пять. Отзови одну из них в другом разговоре',
}

type State =
  | { status: 'loading' }
  | { status: 'error'; text: string }
  | { status: 'none' }
  | { status: 'active'; share: DialogShareApiResponse }

/**
 * "Поделиться": one link per conversation. Without one the sheet asks for the term and warns what the
 * other person will see; with one it shows the link again (the server can always tell it), with
 * copy, the system share sheet where there is one, and revoke. `REQ-DATA-05`.
 */
export default function ShareDialogModal({
  dialogId,
  open,
  onClose,
}: {
  dialogId: string
  open: boolean
  onClose(): void
}) {
  const client = useClient()
  const notify = useNotice()
  const [state, setState] = useState<State>({ status: 'loading' })
  const [ttl, setTtl] = useState<DialogShareTtlHours>(DIALOG_SHARE_DEFAULT_TTL_HOURS)
  const [busy, setBusy] = useState(false)
  const [confirmRevoke, setConfirmRevoke] = useState(false)
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  const load = useCallback(() => {
    setState({ status: 'loading' })
    setConfirmRevoke(false)
    client
      .getDialogShare(dialogId)
      .then((result) => {
        if (!result.ok) setState({ status: 'error', text: codeText(CREATE_ERROR_TEXT, result.code, 'Не получилось открыть') })
        else setState(result.data ? { status: 'active', share: result.data } : { status: 'none' })
      })
      .catch((err: unknown) => setState({ status: 'error', text: apiErrorText(err, {}, 'Не получилось открыть') }))
  }, [client, dialogId])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  async function create() {
    setBusy(true)
    try {
      const result = await client.createDialogShare(dialogId, { ttlHours: ttl })
      if (result.ok) setState({ status: 'active', share: result.data })
      else notify(codeText(CREATE_ERROR_TEXT, result.code, 'Не получилось создать ссылку'), 'error')
    } catch (err) {
      notify(apiErrorText(err, {}, 'Не получилось создать ссылку'), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function revoke() {
    setBusy(true)
    try {
      const result = await client.revokeDialogShare(dialogId)
      if (result.ok) {
        setState({ status: 'none' })
        setConfirmRevoke(false)
        notify('Ссылка отозвана', 'success')
      } else notify(codeText(CREATE_ERROR_TEXT, result.code, 'Не получилось отозвать'), 'error')
    } catch (err) {
      notify(apiErrorText(err, {}, 'Не получилось отозвать'), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      notify('Ссылка скопирована', 'success')
    } catch {
      notify('Не получилось скопировать. Выдели ссылку и скопируй вручную', 'error')
    }
  }

  async function send(share: DialogShareApiResponse) {
    try {
      await navigator.share({
        text: `Поделился(-ась) разговором с тобой в «Рядом». Ссылка действует до ${shareExpiryText(share.expiresAt)}.`,
        url: share.url,
      })
    } catch {
      // Closing the system sheet is a cancellation, not an error.
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Поделиться разговором" className="tab:max-w-md">
      <div data-testid="share-modal" className="flex flex-col gap-4">
        {state.status === 'loading' && (
          <div className="flex justify-center py-6" role="status" aria-busy="true">
            <Spinner />
            <span className="sr-only">Загружаем…</span>
          </div>
        )}

        {state.status === 'error' && (
          <>
            <p className="text-danger" role="alert" data-testid="form-error">
              {state.text}
            </p>
            <Button variant="outline" className={BUTTON} onClick={load}>
              Повторить
            </Button>
          </>
        )}

        {state.status === 'none' && (
          <>
            <p className="text-[0.9375rem] leading-[1.5] text-dim">
              Получатель откроет этот разговор по ссылке, без входа в приложение. Он только читает.
            </p>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-[0.8125rem] font-semibold text-faint">Ссылка действует</legend>
              <div className="flex gap-1 rounded-full border border-line p-1" role="radiogroup" aria-label="Срок ссылки">
                {DIALOG_SHARE_TTL_HOURS.map((hours) => (
                  <button
                    key={hours}
                    type="button"
                    role="radio"
                    aria-checked={ttl === hours}
                    data-testid={`share-ttl-${hours}`}
                    onClick={() => setTtl(hours)}
                    className={cn(
                      BUTTON,
                      'min-h-9 flex-1 rounded-full px-3 text-[0.9375rem]',
                      ttl === hours ? 'bg-brand-fill font-medium text-white' : 'text-dim',
                    )}
                  >
                    {TTL_LABEL[hours]}
                  </button>
                ))}
              </div>
            </fieldset>
            <p
              className="rounded-lg border border-peach/40 bg-peach/10 px-3 py-2.5 text-[0.8125rem] leading-[1.5] text-dim"
              data-testid="share-warning"
            >
              Получатель увидит <b className="text-foreground">весь текст</b> разговора как есть. Сводка, оценки
              напряжения и голос не передаются. Ссылку можно отозвать в любой момент.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" className={BUTTON} onClick={onClose}>
                Отмена
              </Button>
              <Button className={BUTTON} onClick={() => void create()} disabled={busy} data-testid="share-create">
                <Link2 aria-hidden="true" />
                Создать ссылку
              </Button>
            </div>
          </>
        )}

        {state.status === 'active' && (
          <>
            <p className="flex items-center gap-2 font-semibold text-sage" data-testid="share-active">
              <Link2 aria-hidden="true" className="size-4" /> Ссылка активна
            </p>
            <input
              readOnly
              value={state.share.url}
              aria-label="Ссылка на разговор"
              data-testid="share-url"
              onFocus={(event) => event.currentTarget.select()}
              className="w-full rounded-lg border border-line-strong bg-surface px-3 py-2.5 font-mono text-[0.8125rem] text-brand-400"
            />
            <p className="text-[0.8125rem] leading-[1.5] text-faint" data-testid="share-meta">
              Действует до {shareExpiryText(state.share.expiresAt)} · {shareViewsText(state.share.viewCount)}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button className={BUTTON} onClick={() => void copy(state.share.url)} data-testid="share-copy">
                <Copy aria-hidden="true" />
                Скопировать
              </Button>
              {canShare && (
                <Button variant="outline" className={BUTTON} onClick={() => void send(state.share)} data-testid="share-send">
                  <Send aria-hidden="true" />
                  Отправить…
                </Button>
              )}
            </div>
            <p className="text-[0.8125rem] leading-[1.5] text-faint">
              Чтобы сменить срок, отзови ссылку и создай новую.
            </p>
            <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
              {confirmRevoke ? (
                <div className="flex items-center gap-2">
                  <Button variant="destructive" className={BUTTON} onClick={() => void revoke()} disabled={busy} data-testid="share-revoke-confirm">
                    Да, отозвать
                  </Button>
                  <Button variant="ghost" className={BUTTON} onClick={() => setConfirmRevoke(false)}>
                    Нет
                  </Button>
                </div>
              ) : (
                <Button variant="outline" className={cn(BUTTON, 'text-danger')} onClick={() => setConfirmRevoke(true)} data-testid="share-revoke">
                  <Trash2 aria-hidden="true" />
                  Отозвать ссылку
                </Button>
              )}
              <Button variant="ghost" className={BUTTON} onClick={onClose}>
                Закрыть
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
