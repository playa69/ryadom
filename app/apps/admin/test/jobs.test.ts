/**
 * The admin app queues the erasure of a deleted person in analytics itself: a producer of the job queue is registered
 * at server start (`instrumentation.ts` → `lib/jobs.ts`), the job is written in the transaction of the deletion, and the
 * API's workers do the erasure. The admin app does not depend on the API having started: it creates the queue it posts to.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accountDeletionProcess, DeleteUserAccountOperation } from '@ryadom/core/processes/account-deletion'
import { DeviceLoginOperation, authenticationProcess } from '@ryadom/core/processes/authentication'
import { registerJobQueueTransport } from '@ryadom/core/services/job-queue-service'
import { inTransaction } from '@ryadom/core/shared'
import type { JobProducer } from '@ryadom/db/jobs'
import { registerAdminJobQueue } from '../lib/jobs'
import { handle } from './db'

const producers: JobProducer[] = []

afterEach(async () => {
  await Promise.allSettled(producers.splice(0).map((producer) => producer.stop()))
})

const client = () => handle.sql

async function account(): Promise<string> {
  const result = await authenticationProcess.execute(
    new DeviceLoginOperation({ deviceId: randomUUID(), deviceKey: randomBytes(32).toString('base64url') }),
  )
  if (!result.success) throw new Error(`device sign-in failed: ${result.error}`)
  return result.user.id
}

function agentErases() {
  vi.stubGlobal('fetch', async () => new Response(null, { status: 204 }))
}

const erase = (userId: string) =>
  accountDeletionProcess.execute(new DeleteUserAccountOperation({ adminEmail: 'admin@example.com', userId }))

const jobsFor = (userId: string) =>
  client()<{ name: string; state: string; singleton_key: string; start_after: string }[]>`
    select name, state, singleton_key, start_after from pgboss.job where data->>'userId' = ${userId}`

describe('очередь в админке', () => {
  it('удаление аккаунта администратором ставит стирание профиля в аналитике, а сама очередь создаётся без api', async () => {
    producers.push(registerAdminJobQueue({ DATABASE_URL: process.env.DATABASE_URL! }))
    agentErases()
    const userId = await account()
    const [before] = await client()<
      { count: string }[]
    >`select count(*) as count from pgboss.queue where name = 'analytics.erase-person'`
    expect(Number(before?.count)).toBe(0)

    expect(await erase(userId)).toEqual({ success: true })

    const jobs = await jobsFor(userId)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ name: 'analytics.erase-person', state: 'created', singleton_key: userId })
    const waits = (new Date(jobs[0]!.start_after).getTime() - Date.now()) / 1000
    expect(waits).toBeGreaterThan(20)
    expect(waits).toBeLessThanOrEqual(31)
    // The workers that will take it are the API's: this process registered none.
    const [instances] = await client()<{ count: string }[]>`select count(*) as count from pgboss.instance`
    expect(Number(instances?.count)).toBe(0)
  })

  it('откат транзакции с удалением уносит и аккаунт, и задачу', async () => {
    producers.push(registerAdminJobQueue({ DATABASE_URL: process.env.DATABASE_URL! }))
    agentErases()
    const userId = await account()

    await expect(
      inTransaction(async () => {
        await erase(userId)
        throw new Error('the scenario failed after the deletion')
      }),
    ).rejects.toThrow('scenario failed')

    expect(await jobsFor(userId)).toEqual([])
    const [row] = await client()<{ is_deleted: boolean }[]>`select is_deleted from users where id = ${userId}`
    expect(row?.is_deleted).toBe(false)
  })

  it('без зарегистрированного транспорта удаление не проходит: аккаунт остаётся целым', async () => {
    agentErases()
    const userId = await account()
    registerJobQueueTransport(undefined)

    await expect(erase(userId)).rejects.toThrow('No job queue transport')

    const [row] = await client()<{ is_deleted: boolean }[]>`select is_deleted from users where id = ${userId}`
    expect(row?.is_deleted).toBe(false)
  })
})
