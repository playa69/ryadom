/**
 * The voice pipeline of new conversations, picked by an admin (`openspec/changes/add-sber-voice-pipeline`,
 * «Выбор голосового пути», «Журнал действий»).
 */
import { describe, expect, it } from 'vitest'
import { auditLogManager, GetAuditLogQuery } from '../src/managers/audit-log-manager'
import { GetVoicePipelineQuery, voiceSettingsManager } from '../src/managers/voice-settings-manager'
import {
  ChangeVoicePipelineOperation,
  type VoicePipeline,
  voiceSettingsProcess,
} from '../src/processes/voice-settings'
import { ValidationError } from '../src/shared'
import { registerConfirmedUser } from './helpers'

const change = (pipeline: VoicePipeline, adminEmail = 'Admin@Example.com ') =>
  voiceSettingsProcess.execute(new ChangeVoicePipelineOperation({ adminEmail, pipeline }))
const current = async () => (await voiceSettingsManager.execute(new GetVoicePipelineQuery())).settings
const audit = async (targetUserId?: string) =>
  (await auditLogManager.execute(new GetAuditLogQuery({ page: 1, pageSize: 50, targetUserId }))).entries

describe('голосовой путь', () => {
  it('пока никто не выбирал — Сбер, без автора и времени', async () => {
    expect(await current()).toEqual({ pipeline: 'sber', updatedAt: null, updatedBy: null })
  })

  it('смена пути записывает его, автора и запись журнала без аккаунта с подробностями «было — стало»', async () => {
    const result = await change('gemini')

    expect(result).toMatchObject({
      success: true,
      changed: true,
      settings: { pipeline: 'gemini', updatedBy: 'admin@example.com' },
    })
    expect((await current()).updatedAt).toBeInstanceOf(Date)
    const [entry] = await audit()
    expect(entry).toMatchObject({
      adminEmail: 'admin@example.com',
      action: 'VOICE_PIPELINE_CHANGED',
      targetUserId: null,
      targetEmail: null,
      payload: { from: 'sber', to: 'gemini' },
    })

    expect(await change('sber')).toMatchObject({ changed: true, settings: { pipeline: 'sber' } })
    expect((await audit()).map((e) => e.payload)).toEqual([
      { from: 'gemini', to: 'sber' },
      { from: 'sber', to: 'gemini' },
    ])
  })

  it('тот же путь ничего не меняет и в журнал не пишется, в том числе путь по умолчанию', async () => {
    expect(await change('sber')).toMatchObject({
      success: true,
      changed: false,
      settings: { pipeline: 'sber', updatedBy: null },
    })
    await change('gemini')
    expect(await change('gemini')).toMatchObject({ changed: false, settings: { pipeline: 'gemini' } })
    expect(await audit()).toHaveLength(1)
  })

  it('два администратора одновременно сохраняют один путь — одна запись в журнале', async () => {
    const results = await Promise.all([change('gemini', 'a@example.com'), change('gemini', 'b@example.com')])

    expect(results.filter((r) => r.changed)).toHaveLength(1)
    expect((await current()).pipeline).toBe('gemini')
    expect(await audit()).toHaveLength(1)
  })

  it('смена пути не попадает в журнал одного аккаунта', async () => {
    const user = await registerConfirmedUser()
    await change('gemini')

    expect(await audit(user.id)).toEqual([])
  })

  it('путь вне списка — ошибка вызывающего, ничего не пишется', async () => {
    await expect(change('robot' as VoicePipeline)).rejects.toBeInstanceOf(ValidationError)
    expect(await current()).toMatchObject({ pipeline: 'sber', updatedBy: null })
    expect(await audit()).toEqual([])
  })
})
