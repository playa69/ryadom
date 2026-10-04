import { Button, Icon, Preloader } from 'framework7-react'
import { useEffect, useState } from 'react'
import { APP_UPDATE_EVENT, dismissStoreBanner, type UpdateUiState } from '../lib/app-update'
import { getWebUrl } from '../lib/env'
import { openExternal } from '../lib/links'
import { applyServiceWorkerUpdate } from '../lib/service-worker'
import { BrandMark } from './Brand'

/**
 * UI for the version policy:
 * - store-required: a gate over everything that cannot be closed (the API answers 426 anyway);
 * - store-banner: a banner about the new version, dismissible;
 * - js-updating: an overlay while a mandatory OTA bundle is being applied;
 * - pending: a mandatory bundle is waiting for a critical operation to finish;
 * - web-update: a new service worker in the web build is waiting for the button.
 */
export default function AppUpdateGate() {
  const [state, setState] = useState<UpdateUiState>({ kind: 'none' })
  // Unlike store-banner, `pending` and `web-update` do not remember a dismissal across restarts
  // (there is no version number to key it on): closing one only hides it until the next real
  // state change, which is enough to stop it parking over the navbar and SOS for good.
  const [dismissedKind, setDismissedKind] = useState<UpdateUiState['kind'] | null>(null)

  useEffect(() => {
    const handler = (event: Event) => setState((event as CustomEvent<UpdateUiState>).detail)
    window.addEventListener(APP_UPDATE_EVENT, handler)
    return () => window.removeEventListener(APP_UPDATE_EVENT, handler)
  }, [])

  useEffect(() => {
    setDismissedKind((current) => (current === state.kind ? current : null))
  }, [state.kind])

  if (state.kind === 'store-required') {
    const fallback = `${getWebUrl()}/download`
    return (
      <div className="rd-blocking" role="dialog" aria-modal="true" aria-labelledby="rd-update-title">
        <BrandMark size={64} />
        <h1 id="rd-update-title" className="rd-title">
          Нужно обновить приложение
        </h1>
        <p className="rd-muted">Эта версия больше не работает с сервером. Поставь свежую&nbsp;— всё на месте.</p>
        <div className="rd-blocking-actions">
          {state.storeUrl && (
            <Button fill large onClick={() => void openExternal(state.storeUrl!)}>
              Обновить в магазине
            </Button>
          )}
          {state.downloadUrl && (
            <Button large outline onClick={() => void openExternal(state.downloadUrl!)}>
              Скачать напрямую
            </Button>
          )}
          {!state.storeUrl && !state.downloadUrl && (
            <Button fill large onClick={() => void openExternal(fallback)}>
              Открыть страницу загрузки
            </Button>
          )}
        </div>
      </div>
    )
  }

  if (state.kind === 'store-banner') {
    const target = state.storeUrl ?? state.downloadUrl ?? `${getWebUrl()}/download`
    return (
      <div className="rd-banner" role="status">
        <Icon f7="arrow_down_circle_fill" size={22} />
        <span className="rd-banner-text">Вышла новая версия</span>
        <button type="button" className="rd-banner-action" onClick={() => void openExternal(target)}>
          Обновить
        </button>
        <button
          type="button"
          className="rd-banner-close"
          aria-label="Скрыть"
          onClick={() => dismissStoreBanner(state.versionCode)}
        >
          <Icon f7="xmark" size={16} />
        </button>
      </div>
    )
  }

  if (state.kind === 'js-updating') {
    return (
      <div className="rd-blocking" role="status" aria-live="polite">
        <BrandMark size={64} />
        <Preloader size={36} />
        <p className="rd-muted">Обновляемся&nbsp;— это пара секунд</p>
      </div>
    )
  }

  if (state.kind === 'pending' && dismissedKind !== 'pending') {
    return (
      <div className="rd-banner" role="status">
        <Icon f7="arrow_down_circle_fill" size={22} />
        <span className="rd-banner-text">Обновимся, когда закончится разговор</span>
        {/* Unlike store-required, this update is not blocking anything right now, so hiding the
            notice must be possible — otherwise it sits over the navbar and SOS for however long
            the conversation runs (design review). */}
        <button
          type="button"
          className="rd-banner-close"
          aria-label="Скрыть"
          onClick={() => setDismissedKind('pending')}
        >
          <Icon f7="xmark" size={16} />
        </button>
      </div>
    )
  }

  if (state.kind === 'web-update' && dismissedKind !== 'web-update') {
    return (
      <div className="rd-banner" role="status">
        <Icon f7="arrow_down_circle_fill" size={22} />
        <span className="rd-banner-text">Вышла новая версия</span>
        <button type="button" className="rd-banner-action" onClick={() => applyServiceWorkerUpdate()}>
          Обновить
        </button>
        <button
          type="button"
          className="rd-banner-close"
          aria-label="Скрыть"
          onClick={() => setDismissedKind('web-update')}
        >
          <Icon f7="xmark" size={16} />
        </button>
      </div>
    )
  }

  return null
}
