import { createClient, type ClientConfig, type RyadomClient } from '@ryadom/client-core/client'
import { createLocalSessionStorage } from '@ryadom/client-core/storage'
import { toWsBase } from './api-url'

type Handlers = Pick<ClientConfig, 'onAccountUnavailable' | 'onSessionEnd' | 'onUpgradeRequired'>

/** One client per page load; it reads storage lazily, so creating it during SSR is harmless. */
export function createWebClient(apiBase: string, handlers: () => Handlers): RyadomClient {
  return createClient({
    apiBase: () => apiBase,
    wsBase: () => toWsBase(apiBase),
    storage: createLocalSessionStorage(),
    // Called through a ref-backed getter so the handlers may change without re-creating the client.
    onAccountUnavailable: (code) => handlers().onAccountUnavailable?.(code),
    onSessionEnd: () => handlers().onSessionEnd?.(),
    onUpgradeRequired: () => handlers().onUpgradeRequired?.(),
  })
}
