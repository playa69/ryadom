import { afterEach, describe, expect, it } from 'vitest'
import {
  AFTER_DELETE_DELAY_SECONDS,
  CancelJobRequest,
  EnqueueJobRequest,
  ERASE_PERSON_DELAY_SECONDS,
  JobQueue,
  getEnqueuedJobs,
  jobQueueService,
  memoryJobQueueTransport,
  registerJobQueueTransport,
} from '../src/services/job-queue-service'

/**
 * `openspec/changes/add-job-queue`, design D3: the core knows only the port. The jobs of the tests go to the memory
 * transport (registered by test/setup.ts); the real queue is tested in services/api/test/jobs.test.ts.
 */

afterEach(() => registerJobQueueTransport(memoryJobQueueTransport))

describe('постановка задач через порт ядра', () => {
  it('задача попадает в транспорт memory с данными и параметрами', async () => {
    const result = await jobQueueService.execute(
      new EnqueueJobRequest({
        queue: JobQueue.AnalyticsErasePerson,
        data: { userId: 'user-1' },
        startAfterSeconds: ERASE_PERSON_DELAY_SECONDS,
        singletonKey: 'user-1',
      }),
    )

    expect(result.success).toBe(true)
    expect(result.jobId).toEqual(expect.any(String))
    expect(getEnqueuedJobs()).toEqual([
      expect.objectContaining({
        id: result.jobId,
        queue: 'analytics.erase-person',
        data: { userId: 'user-1' },
        startAfterSeconds: 30,
        singletonKey: 'user-1',
      }),
    ])
  })

  it('необязательные параметры не попадают в задачу, если не заданы', async () => {
    await jobQueueService.execute(
      new EnqueueJobRequest({
        queue: JobQueue.DialogsAfterDelete,
        data: { userId: 'user-1', dialogId: 'dialog-1', dialogAt: '2026-10-26T09:00:00.000Z' },
      }),
    )

    const [job] = getEnqueuedJobs()
    expect(job).not.toHaveProperty('startAfterSeconds')
    expect(job).not.toHaveProperty('singletonKey')
    expect(AFTER_DELETE_DELAY_SECONDS).toBe(120)
  })

  it('без зарегистрированного транспорта постановка — исключение, а не потерянная задача', async () => {
    registerJobQueueTransport(undefined)

    await expect(
      jobQueueService.execute(
        new EnqueueJobRequest({ queue: JobQueue.AnalyticsErasePerson, data: { userId: 'user-1' } }),
      ),
    ).rejects.toThrow('No job queue transport is registered')
  })

  it('дубль по ключу возвращает jobId: null, пока первая задача ждёт', async () => {
    const request = () =>
      new EnqueueJobRequest({
        queue: JobQueue.AnalyticsErasePerson,
        data: { userId: 'user-1' },
        startAfterSeconds: 30,
        singletonKey: 'user-1',
      })

    const first = await jobQueueService.execute(request())
    const second = await jobQueueService.execute(request())
    const other = await jobQueueService.execute(
      new EnqueueJobRequest({
        queue: JobQueue.AnalyticsErasePerson,
        data: { userId: 'user-2' },
        singletonKey: 'user-2',
      }),
    )

    expect(first.jobId).toEqual(expect.any(String))
    expect(second).toEqual({ success: true, jobId: null })
    expect(other.jobId).toEqual(expect.any(String))
    expect(getEnqueuedJobs()).toHaveLength(2)
  })

  it('отмена убирает ждущую задачу; отмена уже ушедшей задачи — не ошибка', async () => {
    const { jobId } = await jobQueueService.execute(
      new EnqueueJobRequest({
        queue: JobQueue.DialogsAfterDelete,
        data: { userId: 'user-1', dialogId: 'dialog-1', dialogAt: '2026-10-26T09:00:00.000Z' },
        singletonKey: 'user-1:dialog-1',
      }),
    )

    const cancel = new CancelJobRequest({ queue: JobQueue.DialogsAfterDelete, jobId: jobId! })
    expect(await jobQueueService.execute(cancel)).toEqual({ success: true })
    expect(getEnqueuedJobs()).toEqual([])
    expect(await jobQueueService.execute(cancel)).toEqual({ success: true })
  })
})
