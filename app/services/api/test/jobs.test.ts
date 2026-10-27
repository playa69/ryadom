/**
 * The job queue of the API against a real PostgreSQL and real pg-boss: `openspec/changes/add-job-queue`.
 *
 * The schema `pgboss` comes with the template of the test database (the migrator installs it, design D2). The tests
 * stop every instance they start and clear the jobs and schedules afterwards, so one test leaves nothing to the next.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testDatabase } from '@ryadom/db/test-db'
import { inTransaction, getDb } from '@ryadom/core/shared'
import { resetEnvCache } from '@ryadom/core/config'
import {
  agentApiIntegration,
  DeleteAgentDialogRequest,
  DeleteAgentDialogRequestErrorCode,
  EraseAgentUserRequest,
  GetAgentDialogRequest,
} from '@ryadom/core/integrations/agent-api'
import {
  EnqueueJobRequest,
  JobQueue,
  jobQueueService,
  type JobQueueName,
} from '@ryadom/core/services/job-queue-service'
import { QUEUE_CATALOG, type QueueDefinition } from '../src/jobs/catalog'
import type { JobDeps } from '../src/jobs/handlers'
import { ensureQueues, queueDrift, registerSchedules, type JobHandlers } from '../src/jobs/registry'
import { startJobs, type Jobs, type JobsConfig } from '../src/lib/jobs'

const DATABASE_URL = process.env.DATABASE_URL!

function config(overrides: Partial<JobsConfig> = {}): JobsConfig {
  return {
    DATABASE_URL,
    JOBS_WORKERS_ENABLED: true,
    JOBS_POOL_MAX: 3,
    JOBS_STOP_TIMEOUT_MS: 5_000,
    ...overrides,
  }
}

const deps: JobDeps = {
  sessions: { purgeExpired: async () => {} },
  analytics: { capture: () => {} },
}

/** The queue of a test only: not in the catalog of the product, so the product's queues stay out of the way. */
const SLOW = 'jobs.test-slow' as JobQueueName
const DEFINITION: QueueDefinition['options'] = {
  policy: 'standard',
  expireInSeconds: 60,
  retentionSeconds: 3600,
  deleteAfterSeconds: 3600,
  retryLimit: 2,
  retryDelay: 1,
  retryBackoff: false,
  retryDelayMax: null,
  heartbeatSeconds: null,
  deadLetter: null,
}

const started: Jobs[] = []

/** Starts an instance of the queue for the test; the instance is stopped in `afterEach`. */
async function start(
  overrides: Partial<JobsConfig> = {},
  testing: NonNullable<Parameters<typeof startJobs>[0]['testing']> = {},
): Promise<Jobs> {
  const jobs = await startJobs({
    config: config(overrides),
    deps,
    testing: { pollingIntervalSeconds: 0.5, ...testing },
  })
  started.push(jobs)
  return jobs
}

beforeEach(async () => {
  await clearQueueTables()
})

afterEach(async () => {
  await Promise.allSettled(
    started.splice(0).map((jobs) => jobs.boss.stop({ graceful: false, timeout: 1_000 })),
  )
  await clearQueueTables()
})

async function clearQueueTables(): Promise<void> {
  await getDb().execute(sql`delete from pgboss.job`)
  await getDb().execute(sql`delete from pgboss.schedule`)
}

function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { opened, open }
}

describe('каркас очереди задач', () => {
  // `openspec/changes/add-job-queue`, tasks 3.1.
  it('задача, поставленная внутри inTransaction, видна после коммита и отсутствует после отката', async () => {
    const jobs = await start({ JOBS_WORKERS_ENABLED: false })
    const request = (key: string) =>
      new EnqueueJobRequest({ queue: JobQueue.SessionsPurgeExpired, data: {}, singletonKey: key })

    await inTransaction(async () => {
      await jobQueueService.execute(request('committed'))
    })
    await expect(
      inTransaction(async () => {
        await jobQueueService.execute(request('rolled-back'))
        throw new Error('the scenario failed after the job was queued')
      }),
    ).rejects.toThrow('scenario failed')

    const queued = await jobs.boss.findJobs(JobQueue.SessionsPurgeExpired)
    expect(queued.map((job) => job.singletonKey)).toEqual(['committed'])
  })

  it('постановка вне транзакции работает через пул самой очереди; задача отложена и ждёт своего срока', async () => {
    const jobs = await start({ JOBS_WORKERS_ENABLED: false })

    const { jobId } = await jobQueueService.execute(
      new EnqueueJobRequest({
        queue: JobQueue.SessionsPurgeExpired,
        data: {},
        startAfterSeconds: 30,
        singletonKey: 'user-1',
      }),
    )

    const [job] = await jobs.boss.findJobs(JobQueue.SessionsPurgeExpired)
    expect(job).toMatchObject({ id: jobId, state: 'created', singletonKey: 'user-1' })
    const waits = (job!.startAfter.getTime() - Date.now()) / 1000
    expect(waits).toBeGreaterThan(25)
    expect(waits).toBeLessThanOrEqual(31)
  })

  it('повторный запуск и одновременный запуск двух экземпляров не падают', async () => {
    await start({ JOBS_WORKERS_ENABLED: false })
    // Two replicas of a rollout create the same queues at the same moment.
    await Promise.all([start({ JOBS_WORKERS_ENABLED: false }), start({ JOBS_WORKERS_ENABLED: false })])
    await start({ JOBS_WORKERS_ENABLED: false })
    expect(started).toHaveLength(4)
  })

  it('запуск на базе без схемы — исключение: под не поднимется, старые продолжат работать', async () => {
    const name = `ryadom_jobs_empty_${process.pid}`
    await getDb().execute(sql.raw(`create database "${name}"`))
    try {
      const url = new URL(testDatabase().adminUrl)
      url.pathname = `/${name}`
      await expect(start({ DATABASE_URL: url.toString(), JOBS_WORKERS_ENABLED: false })).rejects.toThrow(
        'pg-boss is not installed',
      )
    } finally {
      await getDb().execute(sql.raw(`drop database if exists "${name}" with (force)`))
    }
  })
})

describe('реестр и каталог очередей', () => {
  // `openspec/changes/add-job-queue`, tasks 3.2.
  const EXPECTED = {
    'jobs.dead-letter': {
      policy: 'standard',
      expireInSeconds: 900,
      retentionSeconds: 30 * 86_400,
      retryLimit: 0,
      deadLetter: null,
    },
    'sessions.purge-expired': {
      policy: 'short',
      expireInSeconds: 300,
      retryLimit: 0,
      heartbeatSeconds: null,
      cron: '0 * * * *',
    },
    'accounts.purge-inactive-anonymous': {
      policy: 'short',
      expireInSeconds: 1800,
      retryLimit: 0,
      heartbeatSeconds: 30,
      cron: '15 * * * *',
    },
    'diary.weekly-pass': {
      policy: 'exclusive',
      expireInSeconds: 600,
      retryLimit: 0,
      heartbeatSeconds: 30,
      cron: '* * * * *',
    },
  } as const

  it('параметры очередей в базе совпадают с таблицей решения D4', async () => {
    const jobs = await start({ JOBS_WORKERS_ENABLED: false })

    for (const [name, expected] of Object.entries(EXPECTED)) {
      const queue = await jobs.boss.getQueue(name)
      const { cron, ...options } = expected as typeof expected & { cron?: string }
      expect(queue, name).toMatchObject({
        ...options,
        deleteAfterSeconds: name === 'jobs.dead-letter' ? 30 * 86_400 : 86_400,
      })
      if (name !== 'jobs.dead-letter') expect(queue?.deadLetter, name).toBe('jobs.dead-letter')
      expect(QUEUE_CATALOG.find((item) => item.name === name)?.cron, name).toBe(cron)
    }
    // Nothing in the catalog is missing from this table.
    expect(QUEUE_CATALOG.map((item) => item.name).sort()).toEqual(Object.keys(EXPECTED).sort())
  })

  it('при JOBS_WORKERS_ENABLED=false ни воркер, ни расписание не регистрируются, а постановка работает', async () => {
    const run = vi.fn(async () => {})
    const handlers: JobHandlers = { [JobQueue.SessionsPurgeExpired]: run }
    const jobs = await start({ JOBS_WORKERS_ENABLED: false }, { handlers })

    expect(jobs.workers).toEqual([])
    expect(jobs.boss.getWipData()).toEqual([])
    expect(await jobs.boss.getSchedules()).toEqual([])

    const { jobId } = await jobQueueService.execute(
      new EnqueueJobRequest({ queue: JobQueue.SessionsPurgeExpired, data: {} }),
    )
    expect(jobId).toEqual(expect.any(String))
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(run).not.toHaveBeenCalled()
  })

  it('при JOBS_WORKERS_ENABLED=true воркеры и расписания регистрируются по каталогу, расписание — одно на очередь', async () => {
    const jobs = await start({ JOBS_WORKERS_ENABLED: true })
    // A second replica registers the same schedules: still one row for each.
    await start({ JOBS_WORKERS_ENABLED: true })

    expect(jobs.workers).toEqual([
      JobQueue.SessionsPurgeExpired,
      JobQueue.AccountsPurgeInactiveAnonymous,
      JobQueue.DiaryWeeklyPass,
    ])
    const schedules = await jobs.boss.getSchedules()
    expect(schedules.map((schedule) => [schedule.name, schedule.cron]).sort()).toEqual([
      [JobQueue.AccountsPurgeInactiveAnonymous, '15 * * * *'],
      [JobQueue.DiaryWeeklyPass, '* * * * *'],
      [JobQueue.SessionsPurgeExpired, '0 * * * *'],
    ])
  })

  it('изменённый параметр приводится к каталогу, а другая политика — ошибка', async () => {
    const jobs = await start({ JOBS_WORKERS_ENABLED: false })
    const catalog: QueueDefinition[] = [{ name: SLOW, options: DEFINITION }]
    await ensureQueues(jobs.boss, catalog)

    const changed: QueueDefinition[] = [
      { name: SLOW, options: { ...DEFINITION, expireInSeconds: 90, retryLimit: 5 } },
    ]
    await ensureQueues(jobs.boss, changed)
    expect(await jobs.boss.getQueue(SLOW)).toMatchObject({ expireInSeconds: 90, retryLimit: 5 })

    const held = (await jobs.boss.getQueue(SLOW))!
    expect(queueDrift(held, changed[0]!.options)).toBeNull()
    await expect(
      ensureQueues(jobs.boss, [{ name: SLOW, options: { ...DEFINITION, policy: 'short' } }]),
    ).rejects.toThrow(/policy/)
    await jobs.boss.deleteQueue(SLOW)
  })

  it('расписание, которого уже нет в коде, снимается, иначе оно продолжало бы ставить задачи без воркера', async () => {
    const jobs = await start({ JOBS_WORKERS_ENABLED: false })
    const catalog: QueueDefinition[] = [{ name: SLOW, options: DEFINITION, cron: '0 3 * * *' }]
    await ensureQueues(jobs.boss, catalog)
    await registerSchedules(jobs.boss, catalog)
    expect((await jobs.boss.getSchedules()).map((schedule) => schedule.name)).toContain(SLOW)

    await registerSchedules(jobs.boss, [])
    expect((await jobs.boss.getSchedules()).map((schedule) => schedule.name)).not.toContain(SLOW)
    await jobs.boss.deleteQueue(SLOW)
  })
})

describe('остановка с настоящей очередью', () => {
  // `openspec/changes/add-job-queue`, «Профиль и события в аналитике»: сценарий «Остановка сервиса» (задача переживает
  // остановку пода); порядок шагов остановки — test/shutdown.test.ts.
  const catalog: QueueDefinition[] = [{ name: SLOW, options: DEFINITION }]

  it('задача, идущая при остановке, успевает завершиться и не доставляется второй раз', async () => {
    const release = gate()
    const ran: string[] = []
    const handlers: JobHandlers = {
      [SLOW]: async () => {
        ran.push('start')
        await release.opened
        ran.push('done')
      },
    } as JobHandlers
    const a = await start({ JOBS_STOP_TIMEOUT_MS: 10_000 }, { catalog, handlers, skipTransport: true })
    await a.boss.send(SLOW, { n: 1 })
    await vi.waitFor(() => expect(ran).toEqual(['start']), { timeout: 10_000 })

    await a.stopTaking()
    // The job ends while the stop is waiting for it.
    setTimeout(release.open, 500)
    await a.stop()

    expect(ran).toEqual(['start', 'done'])
    // The pool is closed after the stop: look at the job through a new instance.
    const b = await start({ JOBS_WORKERS_ENABLED: false }, { catalog, skipTransport: true })
    const [after] = await b.boss.findJobs(SLOW)
    expect(after).toMatchObject({ state: 'completed', retryCount: 0 })
  })

  it('задача, не уложившаяся в срок, возвращается в очередь и берётся другим экземпляром', async () => {
    const hang = gate()
    const first: string[] = []
    const second: string[] = []
    const slow: JobHandlers = {
      [SLOW]: async () => {
        first.push('start')
        await hang.opened
      },
    } as JobHandlers
    const a = await start({ JOBS_STOP_TIMEOUT_MS: 1_000 }, { catalog, handlers: slow, skipTransport: true })
    await a.boss.send(SLOW, { n: 1 })
    await vi.waitFor(() => expect(first).toEqual(['start']), { timeout: 10_000 })

    const b = await start(
      {},
      {
        catalog,
        handlers: { [SLOW]: async () => void second.push('start') } as JobHandlers,
        skipTransport: true,
      },
    )
    const stopped = Date.now()
    await a.stopTaking()
    await a.stop()
    expect(Date.now() - stopped).toBeLessThan(8_000)

    await vi.waitFor(() => expect(second).toEqual(['start']), { timeout: 20_000 })
    const [job] = await b.boss.findJobs(SLOW)
    await vi.waitFor(async () => expect((await b.boss.findJobs(SLOW))[0]?.state).toBe('completed'), {
      timeout: 10_000,
    })
    // The attempt that did not finish is spent.
    expect(job?.retryCount).toBeGreaterThanOrEqual(1)
    hang.open()
  })
})

describe('расписания на нескольких экземплярах', () => {
  // `openspec/changes/add-job-queue`, «Чистка неактивных гостевых аккаунтов»: сценарий «Несколько реплик и частые
  // перезапуски»; «Когда пересчитываются итоги недели»: сценарий «Две реплики».
  it(
    'Несколько реплик и частые перезапуски, Две реплики: каждое расписание срабатывает один раз на оба экземпляра, и под, жившего секунды, это не сдвигает',
    { timeout: 180_000 },
    async () => {
      // The real catalog with every schedule set to fire each minute, so the test need not wait for the top of the hour.
      const fast = QUEUE_CATALOG.map((queue) => (queue.cron ? { ...queue, cron: '* * * * *' } : queue))
      const runs: Record<string, { jobId: string; by: string }[]> = {}
      const handlerFor = (by: string, queue: string): never =>
        (async (_data: unknown, job: { id: string }) => {
          ;(runs[queue] ??= []).push({ jobId: job.id, by })
        }) as never
      const handlers = (by: string): JobHandlers => ({
        [JobQueue.SessionsPurgeExpired]: handlerFor(by, JobQueue.SessionsPurgeExpired),
        [JobQueue.AccountsPurgeInactiveAnonymous]: handlerFor(by, JobQueue.AccountsPurgeInactiveAnonymous),
        [JobQueue.DiaryWeeklyPass]: handlerFor(by, JobQueue.DiaryWeeklyPass),
      })
      const testing = (by: string) => ({
        catalog: fast,
        handlers: handlers(by),
        skipTransport: true,
        boss: { cronWorkerIntervalSeconds: 2, cronMonitorIntervalSeconds: 5 },
      })

      // A pod that lived for a few seconds and was replaced: its life must not move or double the schedules.
      const short = await start({}, testing('short-lived'))
      await short.boss.stop({ graceful: true, timeout: 3_000 })
      await start({}, testing('first'))
      await start({}, testing('second'))

      const queues = [
        JobQueue.SessionsPurgeExpired,
        JobQueue.AccountsPurgeInactiveAnonymous,
        JobQueue.DiaryWeeklyPass,
      ]
      await vi.waitFor(() => expect(queues.every((queue) => (runs[queue]?.length ?? 0) >= 1)).toBe(true), {
        timeout: 120_000,
        interval: 500,
      })
      // Long enough for a second run of one of them to show up, short enough not to cross the next minute.
      await new Promise((resolve) => setTimeout(resolve, 8_000))

      for (const queue of queues) {
        const fired = runs[queue] ?? []
        expect(new Set(fired.map((run) => run.jobId)).size, queue).toBe(fired.length)
        // One minute of the clock is one firing for both instances; a second minute may have started.
        expect(fired.length, queue).toBeLessThanOrEqual(2)
      }
      const firstMinute = queues.map((queue) => runs[queue]![0]!.jobId)
      expect(new Set(firstMinute).size).toBe(queues.length)

      // The queue itself agrees: a job was created for each firing, never two in the same minute.
      const probe = await start({ JOBS_WORKERS_ENABLED: false }, { skipTransport: true })
      for (const queue of queues) {
        const jobs = await probe.boss.findJobs(queue)
        const minutes = jobs.map((job) => Math.floor(job.createdOn.getTime() / 60_000))
        expect(new Set(minutes).size, queue).toBe(jobs.length)
        expect(jobs.length, queue).toBe(runs[queue]!.length)
      }
    },
  )

  it('проход дневника не ставится, пока предыдущий идёт: политика exclusive заменила флаг в памяти', async () => {
    const release = gate()
    let running = 0
    const handlers: JobHandlers = {
      [JobQueue.DiaryWeeklyPass]: async () => {
        running += 1
        await release.opened
      },
    }
    const jobs = await start({}, { handlers, skipTransport: true })

    const first = await jobs.boss.send(JobQueue.DiaryWeeklyPass, {})
    expect(first).toEqual(expect.any(String))
    await vi.waitFor(() => expect(running).toBe(1), { timeout: 10_000 })

    // The minute tick that arrives during the pass is dropped, not queued behind it.
    expect(await jobs.boss.send(JobQueue.DiaryWeeklyPass, {})).toBeNull()
    expect(await jobs.boss.send(JobQueue.DiaryWeeklyPass, {})).toBeNull()

    release.open()
    await vi.waitFor(
      async () => expect((await jobs.boss.findJobs(JobQueue.DiaryWeeklyPass))[0]?.state).toBe('completed'),
      {
        timeout: 10_000,
      },
    )
    expect(await jobs.boss.send(JobQueue.DiaryWeeklyPass, {})).toEqual(expect.any(String))
    expect(running).toBeLessThanOrEqual(2)
  })
})

describe('агент: повторные удаления (заглушка app/dev/agent-mock)', () => {
  // `openspec/changes/add-job-queue`, tasks 2.1: the agent is not changed, a repeated deletion must be a success.
  let mock: ChildProcess | undefined
  let baseUrl = ''

  beforeEach(async () => {
    const port = 20000 + Math.floor(Math.random() * 20000)
    const script = fileURLToPath(new URL('../../../dev/agent-mock/server.mjs', import.meta.url))
    mock = spawn(process.execPath, [script], {
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    await vi.waitFor(
      async () => {
        const response = await fetch(`http://127.0.0.1:${port}/`).catch(() => null)
        expect(response).not.toBeNull()
      },
      { timeout: 15_000, interval: 200 },
    )
    baseUrl = `http://127.0.0.1:${port}`
    vi.stubEnv('AGENT_API_URL', baseUrl)
    vi.stubEnv('AGENT_API_TOKEN', '')
    resetEnvCache()
  })

  afterEach(async () => {
    mock?.kill()
    if (mock && mock.exitCode === null) await once(mock, 'exit').catch(() => {})
    mock = undefined
  })

  it('повторный DELETE /v1/users/{id} — успех: стирать нечего, итог тот, что просили', async () => {
    const userId = '6e0f6a4a-0b43-4b4e-9f7e-3d0c9b8f2a11'
    expect(await agentApiIntegration.execute(new EraseAgentUserRequest({ userId }))).toEqual({ erased: true })
    expect(await agentApiIntegration.execute(new EraseAgentUserRequest({ userId }))).toEqual({ erased: true })
  })

  it('DELETE …/dialogs/{id} уже удалённого разговора — DIALOG_NOT_FOUND, и по нему запись о разговоре считается снятой', async () => {
    const userId = '6e0f6a4a-0b43-4b4e-9f7e-3d0c9b8f2a12'
    const dialogId = '0d7b0a60-6a52-4f76-8d85-5d5c6f2b9c01'

    // An unknown dialog of a known or unknown person: the agent says 404, and so does it for one that was deleted.
    const first = await agentApiIntegration.execute(new DeleteAgentDialogRequest({ userId, dialogId }))
    const again = await agentApiIntegration.execute(new DeleteAgentDialogRequest({ userId, dialogId }))
    expect(first).toEqual({ success: false, error: DeleteAgentDialogRequestErrorCode.DIALOG_NOT_FOUND })
    expect(again).toEqual(first)

    // And the question the follow-up job asks, «is the dialog still there», answers the same way.
    const found = await agentApiIntegration.execute(new GetAgentDialogRequest({ userId, dialogId }))
    expect(found.success).toBe(false)
  })
})
