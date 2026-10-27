import { Preferences } from '@capacitor/preferences'
import { f7 } from 'framework7-react'
import { applyEnv, getEnvId, prodEndpoints, trimSlash, type Endpoints, type EnvId } from './env'
import { isNative } from './platform'

/**
 * Environment switcher, dev build only (`VITE_FLAVOR=dev`).
 *
 * The module is imported dynamically and only under the
 * `import.meta.env.VITE_FLAVOR === 'dev'` check (env.ts, the logo on the sign-in screen and the
 * version on the profile screen): a prod bundle holds neither its code nor the
 * local URLs. A prod build cannot be pointed at someone else's server to
 * capture a session.
 *
 * The choice is kept in Preferences and survives a restart. Switching signs the
 * person out, because the tokens were issued by another server, and reloads the
 * WebView, otherwise some requests would still go to the old address.
 */

const ENV_KEY = 'ryadom.env'
const LOCAL_API_KEY = 'ryadom.env.localApi'

/**
 * The local API server. 10.0.2.2 is the host machine as seen from the Android emulator.
 * On the Vite dev server (browser or live reload) the API goes through its proxy,
 * which means the same origin and an empty address.
 */
function localEndpoints(customApi: string | null): Endpoints {
  const webUrl = isNative() ? 'http://10.0.2.2:3000' : 'http://localhost:3000'
  if (customApi) return { apiBase: customApi, webUrl }
  if (import.meta.env.DEV) return { apiBase: '', webUrl }
  return { apiBase: 'http://10.0.2.2:3002', webUrl }
}

function prodIfConfigured(): Endpoints | null {
  const endpoints = prodEndpoints()
  return endpoints.apiBase ? endpoints : null
}

const TITLES: Record<EnvId, string> = { local: 'Local', prod: 'Prod' }

let customLocalApi: string | null = null

function resolve(id: EnvId): Endpoints | null {
  if (id === 'local') return localEndpoints(customLocalApi)
  return prodIfConfigured()
}

export async function restoreEnv(): Promise<void> {
  let saved: string | null = null
  try {
    const [env, localApi] = await Promise.all([
      Preferences.get({ key: ENV_KEY }),
      Preferences.get({ key: LOCAL_API_KEY }),
    ])
    saved = env.value
    customLocalApi = localApi.value ? trimSlash(localApi.value) : null
  } catch {
    // Storage is unavailable, so start with the default environment.
  }
  // Anything else, `staging` saved by an older dev build included, starts on local.
  const id: EnvId = saved === 'prod' ? 'prod' : 'local'
  const endpoints = resolve(id)
  if (endpoints) applyEnv(id, endpoints)
  else applyEnv('local', localEndpoints(customLocalApi))
}

export function describeEnv(): { id: EnvId; title: string; apiBase: string } {
  const id = getEnvId()
  const endpoints = resolve(id)
  return { id, title: TITLES[id], apiBase: endpoints?.apiBase || '(dev-сервер, прокси)' }
}

async function switchTo(id: EnvId, localApi: string | null, beforeSwitch: () => Promise<void>): Promise<void> {
  await Preferences.set({ key: ENV_KEY, value: id })
  if (localApi !== null) await Preferences.set({ key: LOCAL_API_KEY, value: localApi })
  // The tokens were issued by the previous server: on the new one they will at
  // best be rejected, and at worst show another person's data under this user id.
  await beforeSwitch()
  // Reloading the WebView is the only reliable way: the addresses have spread
  // across modules, open screens and requests already in flight.
  window.location.reload()
}

// ─── environment picker ───────────────────────────────────────────────────────

/**
 * Environment action sheet. There are two hidden entry points: seven taps on the
 * version number on the profile screen, and the same on the logo on the sign-in
 * screen. The second one matters exactly when the first is out of reach: the
 * environment baked into the build is down, so there is no way to sign in.
 *
 * @param beforeSwitch signs out, since a session from another environment must not be kept
 */
export function openEnvSwitcher(beforeSwitch: () => Promise<void>): void {
  const current = describeEnv()
  const option = (id: EnvId) => {
    const endpoints = resolve(id)
    const address = endpoints ? endpoints.apiBase || 'прокси dev-сервера' : 'адрес не задан в сборке'
    return {
      text: `${TITLES[id]} — ${address}`,
      bold: id === current.id,
      disabled: !endpoints,
      onClick: () => {
        if (id !== 'local') {
          void switchTo(id, null, beforeSwitch)
          return
        }
        // Everyone's local address differs: emulator, phone on the same network, another port.
        f7.dialog.prompt(
          'Адрес локального сервера (пусто — по умолчанию)',
          'Local',
          (value: string) => void switchTo('local', trimSlash(value), beforeSwitch),
          undefined,
          customLocalApi ?? localEndpoints(null).apiBase,
        )
      },
    }
  }

  f7.actions
    .create({
      buttons: [
        [
          { text: `Среда: ${current.title}`, label: true },
          option('local'),
          option('prod'),
        ],
        [{ text: 'Отмена', color: 'red' }],
      ],
    })
    .open()
}
