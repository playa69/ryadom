import { randomBytes } from 'node:crypto'
import { PgBoss } from 'pg-boss'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type DbHandle } from '../src'
import {
  QUEUE_CATALOG,
  catalogFor,
  createJobProducer,
  ensureQueues,
  JobQueue,
  type JobProducer,
} from '../src/jobs'
import { runMigrations } from '../src/migrate'
import { prepareTestDatabase, testDatabase } from '../src/test-db'

/**
 * `add-job-queue` and the unification of the erasure: a process that only queues jobs (the admin app) posts them in the
 * transaction of its own scenario, creates the queues it needs itself, and never touches what the API keeps true.
 */

const database = testDatabase()
let drop: () => Promise<void>
let handle: DbHandle
const producers: JobProducer[] = []

beforeAll(async () => {
  drop = await prepareTestDatabase(database)
  handle = createDb(database.url, { max: 3 })
})

afterAll(async () => {
  await Promise.allSettled(producers.map((producer) => producer.stop()))
  await handle.close()
  await drop()
})

afterEach(async () => {
  await Promise.allSettled(producers.splice(0).map((producer) => producer.stop()))
  await handle.sql`delete from pgboss.job`
  await handle.sql`delete from pgboss.queue where left(name, 2) <> '__'`
})

function producer(overrides: Partial<Parameters<typeof createJobProducer>[0]> = {}): JobProducer {
  const created = createJobProducer({
    connectionString: database.url,
    getExecutor: () => handle.db,
    queues: [JobQueue.AnalyticsErasePerson],
    ...overrides,
  })
  producers.push(created)
  return created
}

const queueNames = async () =>
  (
    await handle.sql<
      { name: string }[]
    >`select name from pgboss.queue where left(name, 2) <> '__' order by name`
  ).map((row) => row.name)

describe('производящий экземпляр очереди', () => {
  it('сам создаёт очередь стирания и очередь недоставленных при первой задаче, не ставя воркеров и расписаний', async () => {
    expect(await queueNames()).toEqual([])
    const { transport } = producer()

    const id = await transport.send({
      queue: JobQueue.AnalyticsErasePerson,
      data: { userId: 'user-1' },
      startAfterSeconds: 30,
      singletonKey: 'user-1',
    })

    expect(id).toEqual(expect.any(String))
    expect(await queueNames()).toEqual([JobQueue.JobsDeadLetter, JobQueue.AnalyticsErasePerson].sort())
    const jobs = await handle.sql<{ name: string; state: string; singleton_key: string; data: object }[]>`
      select name, state, singleton_key, data from pgboss.job where name = ${JobQueue.AnalyticsErasePerson}`
    expect(jobs).toEqual([
      {
        name: 'analytics.erase-person',
        state: 'created',
        singleton_key: 'user-1',
        data: { userId: 'user-1' },
      },
    ])
    // It is not a worker: nothing is registered as an instance, nothing is scheduled.
    const [instances] = await handle.sql<{ count: string }[]>`select count(*) as count from pgboss.instance`
    const [schedules] = await handle.sql<{ count: string }[]>`select count(*) as count from pgboss.schedule`
    expect([Number(instances?.count), Number(schedules?.count)]).toEqual([0, 0])
  })

  it('ставит задачу в транзакцию вызывающего: коммит оставляет её, откат уносит; дубль по ключу отбрасывается', async () => {
    let current: Parameters<Parameters<typeof handle.db.transaction>[0]>[0] | undefined
    const { transport } = producer({ getExecutor: () => current ?? handle.db })
    const send = (userId: string) =>
      transport.send({ queue: JobQueue.AnalyticsErasePerson, data: { userId }, singletonKey: userId })

    await handle.db.transaction(async (tx) => {
      current = tx
      await send('committed')
    })
    await expect(
      handle.db.transaction(async (tx) => {
        current = tx
        await send('rolled-back')
        throw new Error('the scenario failed after the job was queued')
      }),
    ).rejects.toThrow('scenario failed')
    current = undefined

    const keys = await handle.sql<{ singleton_key: string }[]>`
      select singleton_key from pgboss.job where name = ${JobQueue.AnalyticsErasePerson}`
    expect(keys.map((row) => row.singleton_key)).toEqual(['committed'])
    expect(await send('committed')).toBeNull()
  })

  it('отмена убирает ждущую задачу; отмена уже ушедшей — не ошибка', async () => {
    const { transport } = producer()
    const id = await transport.send({ queue: JobQueue.AnalyticsErasePerson, data: { userId: 'user-1' } })

    await transport.cancel(JobQueue.AnalyticsErasePerson, id!)
    await transport.cancel(JobQueue.AnalyticsErasePerson, id!)

    const [row] = await handle.sql<{ state: string }[]>`select state from pgboss.job where id = ${id!}`
    expect(row?.state).toBe('cancelled')
  })

  it('параметры уже существующей очереди не трогает: их держит API', async () => {
    const boss = new PgBoss({
      connectionString: database.url,
      migrate: false,
      supervise: false,
      schedule: false,
      registerInstance: false,
      max: 1,
    })
    boss.on('error', () => {})
    await boss.start()
    // Another version of the API created the queue with options of its own.
    await boss.createQueue(JobQueue.JobsDeadLetter, { policy: 'standard', expireInSeconds: 123 })
    await boss.createQueue(JobQueue.AnalyticsErasePerson, {
      policy: 'short',
      expireInSeconds: 99,
      retryLimit: 3,
    })
    await boss.stop({ graceful: false, timeout: 1_000 })
    const { transport } = producer()

    await transport.send({ queue: JobQueue.AnalyticsErasePerson, data: { userId: 'user-1' } })

    const [row] = await handle.sql<{ expire_seconds: number; retry_limit: number }[]>`
      select expire_seconds, retry_limit from pgboss.queue where name = ${JobQueue.AnalyticsErasePerson}`
    expect(row).toEqual({ expire_seconds: 99, retry_limit: 3 })
  })

  it('база без схемы очереди — отказ задачи, а после установки схемы следующая задача проходит', async () => {
    const name = `ryadom_producer_empty_${process.pid}_${randomBytes(2).toString('hex')}`
    const adminSql = postgres(database.adminUrl, { max: 1, onnotice: () => {} })
    const url = new URL(database.adminUrl)
    url.pathname = `/${name}`
    const errors: unknown[] = []
    let other: DbHandle | undefined
    try {
      await adminSql.unsafe(`create database "${name}"`)
      // The job is written through the connection of the caller: here, to the database the producer works on.
      other = createDb(url.toString(), { max: 2 })
      const { transport } = producer({
        connectionString: url.toString(),
        getExecutor: () => other!.db,
        onError: (error) => errors.push(error),
      })
      const job = { queue: JobQueue.AnalyticsErasePerson, data: { userId: 'user-1' } }

      await expect(transport.send(job)).rejects.toThrow('pg-boss is not installed')
      expect(errors.length).toBeGreaterThan(0)

      await runMigrations({ url: url.toString() })
      expect(await transport.send(job)).toEqual(expect.any(String))
    } finally {
      await Promise.allSettled(producers.splice(0).map((p) => p.stop()))
      await other?.close()
      await adminSql.unsafe(`drop database if exists "${name}" with (force)`)
      await adminSql.end({ timeout: 5 })
    }
  })
})

describe('каталог очередей', () => {
  it('сужение каталога берёт очередь и ту, куда она отправляет недоставленные, в порядке каталога', () => {
    expect(catalogFor([JobQueue.AnalyticsErasePerson]).map((queue) => queue.name)).toEqual([
      JobQueue.JobsDeadLetter,
      JobQueue.AnalyticsErasePerson,
    ])
    expect(catalogFor([JobQueue.JobsDeadLetter]).map((queue) => queue.name)).toEqual([
      JobQueue.JobsDeadLetter,
    ])
  })

  it('имена очередей каталога — ровно имена из JobQueue', () => {
    expect(QUEUE_CATALOG.map((queue) => queue.name).sort()).toEqual(Object.values(JobQueue).sort())
  })

  it('ensureQueues без update не меняет параметры, с update — приводит к каталогу', async () => {
    const boss = new PgBoss({
      connectionString: database.url,
      migrate: false,
      supervise: false,
      schedule: false,
      registerInstance: false,
      max: 1,
    })
    boss.on('error', () => {})
    await boss.start()
    try {
      const catalog = catalogFor([JobQueue.AnalyticsErasePerson])
      await boss.createQueue(JobQueue.JobsDeadLetter, { policy: 'standard', expireInSeconds: 123 })

      await ensureQueues(boss, catalog, { update: false })
      expect((await boss.getQueue(JobQueue.JobsDeadLetter))?.expireInSeconds).toBe(123)

      const changed: string[] = []
      await ensureQueues(boss, catalog, { onUpdated: (queue) => changed.push(queue) })
      expect((await boss.getQueue(JobQueue.JobsDeadLetter))?.expireInSeconds).toBe(900)
      expect(changed).toEqual([JobQueue.JobsDeadLetter])
    } finally {
      await boss.stop({ graceful: false, timeout: 1_000 })
    }
  })
})
