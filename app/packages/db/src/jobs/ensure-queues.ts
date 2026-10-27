import type { PgBoss, Queue, QueueResult, UpdateQueueOptions } from 'pg-boss'
import { QUEUE_CATALOG, type QueueDefinition } from './catalog'

type Wanted = QueueDefinition['options']

/**
 * The fields `ensureQueues` keeps equal to the database, as the database holds them. A field that comes back empty
 * counts as unset, which differs from any value the catalog states, so an update fills it in.
 */
function heldBy(queue: QueueResult): { [K in keyof Omit<Wanted, 'policy'>]: unknown } {
  return {
    expireInSeconds: queue.expireInSeconds,
    retentionSeconds: queue.retentionSeconds,
    deleteAfterSeconds: queue.deleteAfterSeconds,
    retryLimit: queue.retryLimit,
    retryDelay: queue.retryDelay,
    retryBackoff: queue.retryBackoff,
    retryDelayMax: queue.retryDelayMax ?? null,
    heartbeatSeconds: queue.heartbeatSeconds ?? null,
    deadLetter: queue.deadLetter || null,
  }
}

/** What differs between the database and the catalog, in the shape `updateQueue` takes; null when nothing does. */
export function queueDrift(held: QueueResult, wanted: Wanted): UpdateQueueOptions | null {
  if (held.policy !== wanted.policy) {
    // pg-boss does not change a policy after creation (design D10): the queue is replaced by a new one under a new name.
    throw new Error(`Queue ${held.name} has the policy ${held.policy}, the catalog wants ${wanted.policy}`)
  }
  const current = heldBy(held)
  const { policy: _policy, ...target } = wanted
  const changed = (Object.keys(target) as (keyof typeof target)[]).filter(
    (key) => current[key] !== target[key],
  )
  if (changed.length === 0) return null
  return Object.fromEntries(changed.map((key) => [key, target[key]])) as UpdateQueueOptions
}

export interface EnsureQueuesOptions {
  /**
   * Bring the options of a queue that exists to the catalog (the default). A process that only queues jobs and may be
   * a version behind the one that works them off (the admin app) leaves existing queues as they are.
   */
  update?: boolean
  /** Called for each queue whose options were changed. */
  onUpdated?: (queue: string, changed: string[]) => void
}

/**
 * Creates every queue of the catalog that is missing and, unless told otherwise, brings the options of the rest to the
 * catalog. `createQueue` leaves an existing queue alone, so a changed option goes through `updateQueue`. Safe to run on
 * every replica at once. Shared by the API, which works the queues off, and the admin app, which only queues: neither
 * depends on the other having started first.
 */
export async function ensureQueues(
  boss: PgBoss,
  catalog: readonly QueueDefinition[] = QUEUE_CATALOG,
  options: EnsureQueuesOptions = {},
): Promise<void> {
  const update = options.update ?? true
  for (const definition of catalog) {
    const { policy, ...rest } = definition.options
    // A `null` of the catalog means "none": the library takes it as an option only in an update.
    const creation: Omit<Queue, 'name'> = {
      policy,
      expireInSeconds: rest.expireInSeconds,
      retentionSeconds: rest.retentionSeconds,
      deleteAfterSeconds: rest.deleteAfterSeconds,
      retryLimit: rest.retryLimit,
      retryDelay: rest.retryDelay,
      retryBackoff: rest.retryBackoff,
      ...(rest.retryDelayMax !== null ? { retryDelayMax: rest.retryDelayMax } : {}),
      ...(rest.heartbeatSeconds !== null ? { heartbeatSeconds: rest.heartbeatSeconds } : {}),
      ...(rest.deadLetter !== null ? { deadLetter: rest.deadLetter } : {}),
    }
    await boss.createQueue(definition.name, creation)
    if (!update) continue
    const held = await boss.getQueue(definition.name)
    if (!held) throw new Error(`Queue ${definition.name} was not created`)
    const drift = queueDrift(held, definition.options)
    if (drift) {
      await boss.updateQueue(definition.name, drift)
      options.onUpdated?.(definition.name, Object.keys(drift))
    }
  }
}

/** The catalog narrowed to the named queues, and to the queues they send their dead jobs to. */
export function catalogFor(
  names: readonly string[],
  catalog: readonly QueueDefinition[] = QUEUE_CATALOG,
): QueueDefinition[] {
  const wanted = new Set<string>(names)
  for (const definition of catalog) {
    if (wanted.has(definition.name) && definition.options.deadLetter)
      wanted.add(definition.options.deadLetter)
  }
  // A receiver is created before the queues that name it.
  return catalog.filter((definition) => wanted.has(definition.name))
}
