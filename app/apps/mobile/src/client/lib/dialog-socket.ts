import { client } from './platform-adapter'

export type {
  DialogMessageView,
  DialogSocket,
  DialogSocketHandlers,
  DialogSocketState,
} from '@ryadom/client-core/index'

/** A dialog connection bound to the app's session and API address. */
export const createDialogSocket = client.createDialogSocket
