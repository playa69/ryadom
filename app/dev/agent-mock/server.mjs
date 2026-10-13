#!/usr/bin/env node
/**
 * `agent-api` mock for local development.
 *
 * It implements exactly the contract our gateway expects: REST to start a dialog, to read the
 * journal, to end a dialog and to erase data, the person's memory (`/memory...`), plus a per-dialog
 * WebSocket that streams the reply. Dialogs and memory live in process memory and disappear on
 * restart - this is a mock, not a service.
 *
 * What is not here and must not be: real models, classifiers. Crisis is detected from a word list
 * and speech "recognition" returns a stub with the duration; memory "extraction" only picks up the
 * person's own "запомни, что ..." (see `MOCK_MEMORY_MODE` below). Speech output is real: replies
 * (and the greeting) are synthesized by espeak-ng and streamed as 24 kHz PCM16 frames, the way the
 * real agent will stream its TTS. See `MOCK_TTS` below.
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { WebSocketServer } from 'ws'

const run = promisify(execFile)

const PORT = Number(process.env.PORT ?? 8080)

/**
 * Speech output (the agent's job). `MOCK_TTS`:
 *   auto (default)  real speech from espeak-ng when it is installed (the container has it), else text only
 *   beep            a short tone per reply, to debug the playback queue
 *   none            text only, like an agent whose TTS is down: the app then reads replies with its own voice
 * Dev only: `POST /dev/tts {"mode": "..."}` changes it while the mock runs (tests flip it), `GET /dev/tts` shows it.
 */
let ttsMode = process.env.MOCK_TTS ?? 'auto'

let espeakAvailable = false
try {
  await run('espeak-ng', ['--version'])
  espeakAvailable = true
} catch {
  console.log('[agent-mock] espeak-ng не найден: озвучки не будет (приложение прочитает ответы своим голосом)')
}

function effectiveTts() {
  if (ttsMode === 'beep' || ttsMode === 'none') return ttsMode
  return espeakAvailable ? 'espeak' : 'none'
}

/**
 * Memory, the agent's long-term notes about the person. `MOCK_MEMORY_MODE`:
 *   on (default)  the feature works: the person can turn it on, and "запомни, что ..." said in a
 *                 conversation becomes a fact when it ends
 *   shadow        the same here (the real agent would just not use the facts in its replies yet)
 *   off           switched off on the server: reading, export and forgetting still work, turning it
 *                 on and writing facts are refused with MEMORY_UNAVAILABLE
 * `MOCK_MEMORY_ALLOWLIST` (user ids, comma-separated) plays a closed beta: anyone else gets
 * MEMORY_NOT_ALLOWED when turning it on. `MOCK_MEMORY_DELAY_MS` (1500): how long `changes` stays
 * `pending` after a conversation ends, the way a real extraction takes a while.
 * Dev only: `POST /dev/memory {"mode": "..."}` changes the mode while the mock runs, `GET /dev/memory` shows it.
 * Texts of facts and messages never reach the log here either: ids and counts only.
 */
const MEMORY_MODES = ['on', 'shadow', 'off']
let memoryMode = MEMORY_MODES.includes(process.env.MOCK_MEMORY_MODE) ? process.env.MOCK_MEMORY_MODE : 'on'
const MEMORY_ALLOWLIST = (process.env.MOCK_MEMORY_ALLOWLIST ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean)
const MEMORY_DELAY_MS = Number(process.env.MOCK_MEMORY_DELAY_MS ?? 1500)
const MEMORY_MAX_FACTS = 60
const MEMORY_RULES_VERSION = 'mock-2026-10-12'
/** The order facts come in: as the profile screen groups them. */
const MEMORY_CATEGORIES = ['style', 'boundary', 'person', 'situation', 'goal', 'works', 'interest', 'recap']
/** A conversation "without memory" is deleted this long after its last message. */
const INCOGNITO_TTL_MS = 24 * 60 * 60 * 1000

/** userId → { dialogs: Map<dialogId, dialog>, memory } */
const users = new Map()

const REPLIES = [
  'Я здесь. Расскажи, что случилось.',
  'Звучит тяжело. Что из этого задело сильнее всего?',
  'Похоже на усталость и обиду одновременно — так?',
  'Спасибо, что говоришь об этом. Что бы тебе сейчас помогло?',
  'Давай помедленнее. Что происходило прямо перед этим?',
]

const CRISIS_WORDS = ['не хочу жить', 'покончить', 'убить себя', 'умереть', 'нет смысла жить']

function userState(userId) {
  if (!users.has(userId)) users.set(userId, { dialogs: new Map(), memory: newMemory() })
  return users.get(userId)
}

function openDialogOf(userId) {
  for (const dialog of userState(userId).dialogs.values()) {
    if (!dialog.endedAt) return dialog
  }
  return null
}

function createDialog(userId, memory = 'on') {
  const dialog = {
    dialogId: randomUUID(),
    userId,
    startedAt: new Date().toISOString(),
    endedAt: null,
    summary: null,
    messages: [],
    replyIndex: 0,
    // Set once, when the dialog is created: a returned open dialog keeps its own.
    memoryMode: memory === 'off' ? 'off' : 'on',
  }
  userState(userId).dialogs.set(dialog.dialogId, dialog)
  return dialog
}

/** Ends the dialog and, when it was held with memory, starts the "extraction" (see `extractMemory`). */
function endDialog(dialog, takeaway, tensionAfter) {
  dialog.endedAt = new Date().toISOString()
  dialog.summary = buildSummary(dialog, takeaway, tensionAfter)
  extractMemory(dialog)
}

/**
 * A canned recap with the agent's rules for when there is none: a talk "without memory", one with a
 * crisis and one where the person said under 40 characters get null. The real one is written by a model.
 */
function buildRecap(dialog) {
  if (dialog.memoryMode === 'off' || dialog.crisisSeen) return null
  const said = dialog.messages.filter((message) => message.role === 'user').map((message) => message.text)
  if (said.join('').length < 40) return null
  return 'Говорили о том, что сейчас на душе. Пришли к тому, что стоит вернуться к этому завтра.'
}

/** Conversations "without memory" are deleted 24 hours after their last message, as the agent does. */
function purgeIncognito(userId) {
  const { dialogs } = userState(userId)
  for (const dialog of [...dialogs.values()]) {
    if (dialog.memoryMode !== 'off') continue
    const lastAt = dialog.messages.at(-1)?.createdAt ?? dialog.endedAt ?? dialog.startedAt
    if (Date.now() - Date.parse(lastAt) > INCOGNITO_TTL_MS) {
      dialogs.delete(dialog.dialogId)
      console.log(`[agent-mock] удалён диалог без памяти ${dialog.dialogId}`)
    }
  }
}

function hoursSinceLastDialog(userId) {
  const ended = [...userState(userId).dialogs.values()]
    .filter((dialog) => dialog.endedAt)
    .sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt))
  if (ended.length === 0) return null
  return Math.round((Date.now() - Date.parse(ended[0].endedAt)) / 3_600_000)
}

function listItem(dialog) {
  return {
    dialogId: dialog.dialogId,
    startedAt: dialog.startedAt,
    endedAt: dialog.endedAt,
    summary: dialog.summary,
    memoryMode: dialog.memoryMode ?? 'on',
  }
}

function buildSummary(dialog, takeaway, tensionAfter) {
  const firstUserMessage = dialog.messages.find((message) => message.role === 'user')
  return {
    title: takeaway ? takeaway.slice(0, 80) : (firstUserMessage?.text.slice(0, 80) ?? 'Разговор'),
    // A real agent derives the themes itself; they reach the journal screen as they are.
    themes: ['выговориться'],
    tensionBefore: null,
    tensionAfter: tensionAfter ?? null,
  }
}

function addMessage(dialog, role, text) {
  const message = {
    id: randomUUID(),
    role,
    text,
    createdAt: new Date().toISOString(),
  }
  dialog.messages.push(message)
  return message
}

function isCrisis(text) {
  const lower = text.toLowerCase()
  return CRISIS_WORDS.some((word) => lower.includes(word))
}

function nextReply(dialog) {
  const reply = REPLIES[dialog.replyIndex % REPLIES.length]
  dialog.replyIndex += 1
  return reply
}

// ─── Memory ───────────────────────────────────────────────────────────────────

function newMemory() {
  return {
    enabled: false,
    consentVersion: null,
    consentAt: null,
    /** Every switch on or off, and "forget everything", moves it: older conversations are not read any more. */
    epochAt: null,
    updatedAt: null,
    /** factId → fact, in the shape of the API. */
    facts: new Map(),
    /** The history of changes, without texts. */
    events: [],
    /** dialogId → { readyAt, items: [{ op, factId }], reason }: one "extraction" per conversation. */
    jobs: new Map(),
  }
}

function memoryAvailable() {
  return memoryMode !== 'off'
}

function memoryEvent(memory, op, actor, factId, dialogId = null) {
  memory.events.push({ factId, op, actor, dialogId, at: new Date().toISOString() })
}

/** What a fact must never hold, a few rules of the real list, so that `FACT_REJECTED` can be seen too. */
const MEMORY_BLOCKLIST = [
  [/\d[\d\s()-]{5,}\d/u, 'contact_pii'],
  [/@|https?:\/\/|www\./iu, 'contact_pii'],
  [/диагноз|депресси|биполяр|шизофрени/iu, 'diagnosis'],
  [/таблетк|антидепрессант|препарат|\bмг\b/iu, 'medication'],
  [/не хочу жить|покончить|убить себя/iu, 'crisis'],
  [/ты (всегда |теперь )?должен|игнорируй|забудь (все |свои )?(инструкции|правила)/iu, 'instruction'],
]

function rejectionOf(text) {
  for (const [pattern, reason] of MEMORY_BLOCKLIST) {
    if (pattern.test(text)) return reason
  }
  return null
}

const STYLE_SLOTS = {
  form: { ty: 'на «ты»', vy: 'на «вы»' },
  length: { short: 'отвечать коротко', normal: 'можно подробно' },
  advice: { ask_first: 'сначала спросить, нужен ли совет', ok: 'советовать можно сразу' },
  tone: { soft: 'мягко', direct: 'прямо' },
}

/** `style` text is built from its slots, as the real agent does; null when the slots do not hold up. */
function styleText(slots) {
  if (!slots || typeof slots !== 'object') return null
  const parts = []
  if (slots.address !== undefined) {
    if (typeof slots.address !== 'string' || !slots.address.trim() || slots.address.length > 30 || /\d|\//u.test(slots.address)) {
      return null
    }
    parts.push(`называть «${slots.address.trim()}»`)
  }
  for (const [key, labels] of Object.entries(STYLE_SLOTS)) {
    if (slots[key] === undefined) continue
    if (!Object.hasOwn(labels, slots[key])) return null
    parts.push(labels[slots[key]])
  }
  if (parts.length === 0) return null
  const text = parts.join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function personText(slots) {
  if (!slots || typeof slots !== 'object' || typeof slots.role !== 'string' || !slots.role.trim() || slots.role.length > 30) {
    return null
  }
  if (slots.name !== undefined && (typeof slots.name !== 'string' || slots.name.length > 20)) return null
  if (slots.note !== undefined && (typeof slots.note !== 'string' || slots.note.length > 60)) return null
  const role = slots.role.trim()
  let text = role.charAt(0).toUpperCase() + role.slice(1)
  if (slots.name) text += ` ${slots.name.trim()}`
  if (slots.note) text += `: ${slots.note.trim()}`
  return text
}

/**
 * The text and slots of a fact the person writes or corrects, as the real agent judges them:
 * `{ text, slots }`, `{ invalid }` (a request of the wrong shape: 422 AGENT_VALIDATION) or
 * `{ rejected }` (the rules refuse it: 422 FACT_REJECTED with the reason). `style` and `person` take
 * only slots, and their text is built from them («Сестра Аня: поддерживает»); the other categories
 * take only a text, and slots sent with it are ignored.
 */
function factContent(category, text, slots) {
  if (!MEMORY_CATEGORIES.includes(category)) return { invalid: 'неизвестная категория' }
  let content
  if (category === 'style' || category === 'person') {
    if (text !== undefined && text !== null && text !== '') return { invalid: 'у этой категории правятся слоты, а не текст' }
    const built = category === 'style' ? styleText(slots) : personText(slots)
    if (built === null) return { rejected: 'bad_slots' }
    content = { text: built, slots }
  } else {
    if (typeof text !== 'string') return { invalid: 'нужен текст' }
    content = { text: text.trim(), slots: null }
  }
  // The agent's minimum for a text the person writes: 8 characters (`MIN_TEXT`). Texts built from slots
  // are not held to it here: «Мама» or «На «ты»» is a whole fact.
  if (content.text.length < (content.slots ? 1 : 8)) return { rejected: 'too_short' }
  if (content.text.length > 200) return { rejected: 'too_long' }
  const reason = rejectionOf(`${content.text} ${JSON.stringify(content.slots ?? {})}`)
  return reason ? { rejected: reason } : content
}

/** Answers as the agent does to a fact it does not take; false when the content is fine. */
function refuseContent(res, content) {
  if (content.invalid) {
    agentError(res, 422, 'AGENT_VALIDATION', content.invalid)
    return true
  }
  if (content.rejected) {
    agentError(res, 422, 'FACT_REJECTED', 'Это нельзя запомнить', { reason: content.rejected })
    return true
  }
  return false
}

function newFact(memory, fields) {
  const now = new Date().toISOString()
  const fact = {
    id: randomUUID(),
    category: fields.category,
    text: fields.text,
    slots: fields.slots ?? null,
    importance: fields.importance ?? 3,
    confidence: fields.confidence ?? 1,
    status: fields.status ?? 'active',
    origin: fields.origin ?? 'auto',
    sensitivity: 'normal',
    sources: fields.sources ?? [],
    createdAt: now,
    updatedAt: now,
    lastConfirmedAt: null,
    expiresAt: null,
    confirmCount: 0,
    seenByUser: fields.seenByUser ?? false,
  }
  memory.facts.set(fact.id, fact)
  return fact
}

function liveFacts(memory) {
  return [...memory.facts.values()].filter((fact) => fact.status !== 'expired')
}

function sortedFacts(facts) {
  return [...facts].sort(
    (a, b) =>
      MEMORY_CATEGORIES.indexOf(a.category) - MEMORY_CATEGORIES.indexOf(b.category) ||
      b.importance - a.importance ||
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  )
}

const normalized = (text) => text.toLowerCase().replace(/ё/gu, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/**
 * The person's own requests "запомни, что ...", one per request: the rest of the sentence after it.
 * This is all the "extraction" the mock does.
 */
function rememberRequests(text) {
  const found = []
  for (const chunk of text.split(/(?=запомни)/iu)) {
    const match = chunk.match(/^запомни[\s,:;—-]*(?:пожалуйста[\s,]*)?(?:что[\s,]+)?([^.!?\n]+)/iu)
    const said = match?.[1]?.trim().replace(/[\s,;:—-]+$/u, '')
    if (said) found.push(said.charAt(0).toUpperCase() + said.slice(1))
  }
  return found
}

/**
 * The extraction at the end of a conversation: every "запомни, что ..." of the person becomes a fact
 * (`works` when it is about what helps, `interest` otherwise), or confirms the one already there.
 * Nothing happens for a conversation "without memory", with memory off for the person or on the server.
 */
function extractMemory(dialog) {
  const memory = userState(dialog.userId).memory
  if (memory.jobs.has(dialog.dialogId)) return
  const readyAt = Date.now() + MEMORY_DELAY_MS
  const skip = (reason) => memory.jobs.set(dialog.dialogId, { readyAt, items: [], reason })
  if (dialog.memoryMode === 'off') return skip('memory_off')
  if (!memory.enabled || !memoryAvailable()) return skip('disabled')
  if (memory.epochAt && Date.parse(dialog.startedAt) < Date.parse(memory.epochAt)) return skip('epoch')

  const items = []
  const date = dialog.startedAt.slice(0, 10)
  for (const message of dialog.messages) {
    if (message.role !== 'user') continue
    for (const said of rememberRequests(message.text)) {
      if (said.length > 200 || rejectionOf(said)) continue
      const same = liveFacts(memory).find((fact) => normalized(fact.text) === normalized(said))
      if (same) {
        same.confirmCount += 1
        same.lastConfirmedAt = new Date().toISOString()
        same.updatedAt = same.lastConfirmedAt
        if (!same.sources.some((source) => source.dialogId === dialog.dialogId)) {
          same.sources.push({ dialogId: dialog.dialogId, date })
        }
        memoryEvent(memory, 'confirm', 'extractor', same.id, dialog.dialogId)
        items.push({ op: 'confirm', factId: same.id })
        continue
      }
      if (liveFacts(memory).length >= MEMORY_MAX_FACTS) continue
      const fact = newFact(memory, {
        category: /помога|помогл|успока/iu.test(said) ? 'works' : 'interest',
        text: said,
        importance: 4,
        origin: 'user_said',
        sources: [{ dialogId: dialog.dialogId, date }],
      })
      memoryEvent(memory, 'add', 'extractor', fact.id, dialog.dialogId)
      items.push({ op: 'add', factId: fact.id })
    }
  }
  memory.jobs.set(dialog.dialogId, { readyAt, items, reason: items.length === 0 ? 'too_short' : null })
  console.log(`[agent-mock] память: диалог ${dialog.dialogId}, изменений ${items.length}`)
}

function memoryView(memory) {
  return {
    available: memoryAvailable(),
    mode: memoryMode,
    enabled: memory.enabled,
    consentVersion: memory.consentVersion,
    consentAt: memory.consentAt,
    rulesVersion: MEMORY_RULES_VERSION,
    limits: { maxFacts: MEMORY_MAX_FACTS },
    facts: sortedFacts(liveFacts(memory)),
  }
}

function memorySettings(memory) {
  return { enabled: memory.enabled, consentVersion: memory.consentVersion, consentAt: memory.consentAt }
}

/** Errors in the agent's format: `{ error: { code, message, details } }`. */
function agentError(res, status, code, message, details = null) {
  return json(res, status, { error: { code, message, details } })
}

// ─── REST ─────────────────────────────────────────────────────────────────────

function json(res, status, body) {
  const payload = body === null ? '' : JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(payload)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

function noContent(res) {
  res.writeHead(204)
  return res.end()
}

/**
 * /v1/users/{userId}/memory... Reading, export and forgetting work in any mode and with the
 * person's memory off; turning it on and writing facts need the feature on the server.
 */
async function handleMemory(req, res, url, userId, parts, method) {
  const memory = userState(userId).memory
  const resource = parts[4] ?? null

  // GET /memory - everything remembered, except expired facts
  if (!resource && method === 'GET') return json(res, 200, memoryView(memory))

  // DELETE /memory - "forget everything": facts, history, extractions; the switch and the consent stay
  if (!resource && method === 'DELETE') {
    const count = memory.facts.size
    memory.facts.clear()
    memory.events = []
    memory.jobs.clear()
    memory.epochAt = new Date().toISOString()
    memory.updatedAt = memory.epochAt
    console.log(`[agent-mock] память пользователя ${userId} стёрта, фактов было ${count}`)
    return noContent(res)
  }

  // PUT /memory/settings - the person's switch; turning it on needs the consent version
  if (resource === 'settings' && parts.length === 5 && method === 'PUT') {
    const body = await readBody(req)
    if (typeof body.enabled !== 'boolean') {
      return agentError(res, 400, 'AGENT_VALIDATION', 'Поле enabled обязательно')
    }
    const now = new Date().toISOString()
    if (body.enabled) {
      if (typeof body.consentVersion !== 'string' || !body.consentVersion) {
        return agentError(res, 422, 'AGENT_VALIDATION', 'Для включения нужна версия согласия')
      }
      if (!memoryAvailable()) return agentError(res, 503, 'MEMORY_UNAVAILABLE', 'Память сейчас недоступна')
      if (MEMORY_ALLOWLIST.length > 0 && !MEMORY_ALLOWLIST.includes(userId)) {
        return agentError(res, 403, 'MEMORY_NOT_ALLOWED', 'Память пока доступна не всем')
      }
      if (!memory.enabled || memory.consentVersion !== body.consentVersion) {
        if (!memory.enabled) memory.epochAt = now
        memory.enabled = true
        memory.consentVersion = body.consentVersion
        memory.consentAt = now
        memory.updatedAt = now
      }
    } else if (memory.enabled) {
      memory.enabled = false
      memory.epochAt = now
      memory.updatedAt = now
    }
    console.log(`[agent-mock] память пользователя ${userId}: ${memory.enabled ? 'включена' : 'выключена'}`)
    return json(res, 200, memorySettings(memory))
  }

  // POST /memory/facts - the person writes a fact themselves: theirs, pinned. The checks go in the
  // agent's order: the feature, the content, the person's switch, the room.
  if (resource === 'facts' && parts.length === 5 && method === 'POST') {
    const body = await readBody(req)
    if (!memoryAvailable()) return agentError(res, 503, 'MEMORY_UNAVAILABLE', 'Память сейчас недоступна')
    const content = factContent(body.category, body.text, body.slots)
    if (refuseContent(res, content)) return
    if (!memory.enabled) return agentError(res, 409, 'MEMORY_DISABLED', 'Память выключена')
    // The person has one style: writing it again replaces it.
    const style = body.category === 'style' ? liveFacts(memory).find((fact) => fact.category === 'style') : null
    if (style) {
      Object.assign(style, {
        text: content.text,
        slots: content.slots,
        origin: 'user_edit',
        status: 'pinned',
        importance: 5,
        confidence: 1,
        updatedAt: new Date().toISOString(),
        seenByUser: true,
      })
      memoryEvent(memory, 'user_edit', 'user', style.id)
      return json(res, 201, style)
    }
    if (liveFacts(memory).length >= MEMORY_MAX_FACTS) {
      return agentError(res, 409, 'MEMORY_FULL', 'Память заполнена')
    }
    const fact = newFact(memory, {
      category: body.category,
      text: content.text,
      slots: content.slots,
      importance: 5,
      status: 'pinned',
      origin: 'user_edit',
      seenByUser: true,
    })
    memoryEvent(memory, 'user_add', 'user', fact.id)
    return json(res, 201, fact)
  }

  // PATCH /memory/facts/{factId} - correct, accept a proposed one, pin or unpin, "right"
  // DELETE /memory/facts/{factId} - forget one; a repeat is fine
  if (resource === 'facts' && parts.length === 6) {
    const factId = decodeURIComponent(parts[5])
    const fact = memory.facts.get(factId)
    if (method === 'DELETE') {
      if (fact) {
        memory.facts.delete(factId)
        memoryEvent(memory, 'user_delete', 'user', factId)
      }
      return noContent(res)
    }
    // The agent's order: the request itself, the feature, the switch, the fact, its new content.
    // A correction, a status and "right" may come together and are applied in that order.
    if (method === 'PATCH') {
      const body = await readBody(req)
      const editing = body.text !== undefined || body.slots !== undefined
      if (!editing && body.status === undefined && body.confirm !== true) {
        return agentError(res, 422, 'AGENT_VALIDATION', 'нечего менять')
      }
      if (body.status !== undefined && body.status !== 'active' && body.status !== 'pinned') {
        return agentError(res, 422, 'AGENT_VALIDATION', 'status: active или pinned')
      }
      if (!memoryAvailable()) return agentError(res, 503, 'MEMORY_UNAVAILABLE', 'Память сейчас недоступна')
      if (!memory.enabled) return agentError(res, 409, 'MEMORY_DISABLED', 'Память выключена')
      if (!fact || fact.status === 'expired') return agentError(res, 404, 'FACT_NOT_FOUND', 'Факт не найден')
      const now = new Date().toISOString()
      if (editing) {
        const content = factContent(fact.category, body.text, body.slots)
        if (refuseContent(res, content)) return
        Object.assign(fact, { text: content.text, slots: content.slots, origin: 'user_edit', status: 'pinned' })
        Object.assign(fact, { importance: 5, confidence: 1, sensitivity: 'normal' })
        memoryEvent(memory, 'user_edit', 'user', fact.id)
      }
      if (body.status !== undefined && body.status !== fact.status) {
        const accepting = fact.status === 'proposed' || fact.status === 'candidate'
        fact.status = body.status
        memoryEvent(memory, accepting ? 'user_confirm' : 'user_edit', 'user', fact.id)
      }
      if (body.confirm === true) {
        fact.confirmCount += 1
        fact.lastConfirmedAt = now
        if (fact.status === 'candidate') fact.status = 'active'
        memoryEvent(memory, 'user_confirm', 'user', fact.id)
      }
      fact.updatedAt = now
      fact.seenByUser = true
      return json(res, 200, fact)
    }
  }

  // GET /memory/changes?dialogId= - what one conversation added: the "I remembered" card
  if (resource === 'changes' && parts.length === 5 && method === 'GET') {
    const dialogId = url.searchParams.get('dialogId') ?? ''
    const dialog = userState(userId).dialogs.get(dialogId)
    if (!dialog) return agentError(res, 404, 'AGENT_DIALOG_NOT_FOUND', 'Диалог не найден')
    const skipped = (reason) => json(res, 200, { status: 'skipped', reason, items: [] })
    // The agent's order: the feature, the conversation's mode, then its extraction.
    if (!memoryAvailable()) return skipped('unavailable')
    if (dialog.memoryMode === 'off') return skipped('memory_off')
    const job = memory.jobs.get(dialogId)
    if (!job) {
      // Still going (the extraction runs when it ends), unless memory is off for the person.
      return memory.enabled ? json(res, 200, { status: 'pending', reason: null, items: [] }) : skipped('disabled')
    }
    if (Date.now() < job.readyAt) return json(res, 200, { status: 'pending', reason: null, items: [] })
    if (job.reason) return skipped(job.reason)
    // The facts as they are now, marked seen as they are given out; forgotten ones are left out.
    const items = job.items
      .map(({ op, factId }) => ({ op, fact: memory.facts.get(factId) }))
      .filter((item) => item.fact && item.fact.status !== 'expired')
      .map((item) => {
        item.fact.seenByUser = true
        return { op: item.op, fact: { ...item.fact } }
      })
    return json(res, 200, { status: 'ready', reason: null, items })
  }

  // GET /memory/export - "download my memory": everything, guesses included, the history without texts
  if (resource === 'export' && parts.length === 5 && method === 'GET') {
    return json(res, 200, {
      exportedAt: new Date().toISOString(),
      rulesVersion: MEMORY_RULES_VERSION,
      settings: {
        enabled: memory.enabled,
        consentVersion: memory.consentVersion,
        consentAt: memory.consentAt,
        epochAt: memory.epochAt,
        updatedAt: memory.updatedAt,
      },
      facts: sortedFacts(memory.facts.values()),
      events: memory.events,
    })
  }

  return json(res, 404, { error: 'not_found' })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname
  const method = req.method ?? 'GET'

  if (path === '/healthz') return json(res, 200, { status: 'ok' })

  // /dev/tts - dev only, not part of the agent contract: shows or changes the speech output mode.
  if (path === '/dev/tts') {
    if (method === 'POST') {
      const body = await readBody(req)
      if (['auto', 'beep', 'none'].includes(body.mode)) ttsMode = body.mode
    }
    return json(res, 200, { mode: ttsMode, effective: effectiveTts(), espeak: espeakAvailable })
  }

  // /dev/memory - dev only, not part of the agent contract: shows or changes the memory mode.
  if (path === '/dev/memory') {
    if (method === 'POST') {
      const body = await readBody(req)
      if (MEMORY_MODES.includes(body.mode)) memoryMode = body.mode
    }
    return json(res, 200, { mode: memoryMode, available: memoryAvailable(), delayMs: MEMORY_DELAY_MS })
  }

  // /v1/users/{userId}...
  const parts = path.split('/').filter(Boolean)
  if (parts[0] !== 'v1' || parts[1] !== 'users' || !parts[2]) return json(res, 404, { error: 'not_found' })
  const userId = decodeURIComponent(parts[2])

  // DELETE /v1/users/{userId} - erase everything
  if (parts.length === 3 && method === 'DELETE') {
    users.delete(userId)
    console.log(`[agent-mock] стёрты все данные пользователя ${userId}`)
    res.writeHead(204)
    return res.end()
  }

  // POST /v1/users/{userId}/seed - dev only, not part of the agent contract: replaces the user's
  // dialogs with ready-made ones (past dates, real-looking text), so screenshots and demos show a
  // lived-in journal instead of a day of test chatter. Body: { dialogs: [{ startedAt, endedAt,
  // summary, memoryMode?, messages: [{ role, text }] }], memory?: { enabled, consentVersion?, facts:
  // [{ category, text, slots?, status?, origin? }] } }, messages get their times spread from startedAt.
  if (parts.length === 4 && parts[3] === 'seed' && method === 'POST') {
    const body = await readBody(req)
    const state = userState(userId)
    state.dialogs.clear()
    if (body.memory) {
      const now = new Date().toISOString()
      state.memory = newMemory()
      state.memory.enabled = body.memory.enabled === true
      state.memory.consentVersion = state.memory.enabled ? (body.memory.consentVersion ?? '2026-10-12') : null
      state.memory.consentAt = state.memory.enabled ? now : null
      state.memory.updatedAt = now
      for (const item of body.memory.facts ?? []) {
        if (!MEMORY_CATEGORIES.includes(item.category) || typeof item.text !== 'string') continue
        newFact(state.memory, {
          category: item.category,
          text: item.text,
          slots: item.slots ?? null,
          status: item.status ?? 'active',
          origin: item.origin ?? 'auto',
          seenByUser: true,
        })
      }
    }
    for (const item of body.dialogs ?? []) {
      const started = Date.parse(item.startedAt)
      const dialog = {
        dialogId: randomUUID(),
        userId,
        startedAt: item.startedAt,
        endedAt: item.endedAt ?? null,
        summary: item.summary ?? null,
        messages: (item.messages ?? []).map((message, index) => ({
          id: randomUUID(),
          role: message.role,
          text: message.text,
          createdAt: new Date(started + (index + 1) * 40_000).toISOString(),
        })),
        replyIndex: 0,
        memoryMode: item.memoryMode === 'off' ? 'off' : 'on',
      }
      state.dialogs.set(dialog.dialogId, dialog)
    }
    return json(res, 200, { count: state.dialogs.size, facts: state.memory.facts.size })
  }

  purgeIncognito(userId)

  if (parts[3] === 'memory') return handleMemory(req, res, url, userId, parts, method)

  if (parts[3] !== 'dialogs') return json(res, 404, { error: 'not_found' })

  // POST /v1/users/{userId}/dialogs - start a dialog or return the open one. A plain start changes
  // nothing (the open dialog comes back `resumed`, with its message count and last activity, so the app
  // can ask the person). `{ new: true }` asks for a fresh conversation: the open one is ended first and
  // stays in the journal, unless it is empty, then it is simply reused; the answer is never `resumed`.
  // `memory: "off"` holds a new dialog "without memory"; a returned open dialog keeps its own mode.
  if (parts.length === 4 && method === 'POST') {
    const body = await readBody(req)
    // Counted before the open dialog is ended, as the real agent does: "time since the last talk" skips it.
    const sinceLastDialogHours = hoursSinceLastDialog(userId)
    let existing = openDialogOf(userId)
    const wantsNew = body.new === true
    let resumed = Boolean(existing)
    if (wantsNew && existing) {
      resumed = false
      if (existing.messages.length > 0) {
        endDialog(existing, null, null)
        existing = null
      } else {
        // An empty one is reused, so it takes the mode asked for now.
        existing.memoryMode = body.memory === 'off' ? 'off' : 'on'
      }
    }
    const dialog = existing ?? createDialog(userId, body.memory)
    dialog.greeting = resumed ? 'Продолжим, где остановились.' : 'Я рядом. С чего начнём?'
    // Voiced once, on the first socket after this start: a reconnect must not read it out again.
    dialog.greetingPending = true
    return json(res, 200, {
      dialogId: dialog.dialogId,
      resumed,
      greeting: dialog.greeting,
      sinceLastDialogHours,
      messageCount: dialog.messages.length,
      lastActivityAt: dialog.messages.at(-1)?.createdAt ?? dialog.endedAt,
      memoryMode: dialog.memoryMode,
      memoryEnabled: userState(userId).memory.enabled && memoryAvailable(),
    })
  }

  // GET /v1/users/{userId}/dialogs - the journal
  if (parts.length === 4 && method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? 20)
    const items = [...userState(userId).dialogs.values()]
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, limit)
      .map(listItem)
    return json(res, 200, { items, next: null })
  }

  const dialogId = parts[4] ? decodeURIComponent(parts[4]) : null
  const dialog = dialogId ? userState(userId).dialogs.get(dialogId) : null

  // GET /v1/users/{userId}/dialogs/{dialogId}
  if (parts.length === 5 && method === 'GET') {
    if (!dialog) return agentError(res, 404, 'AGENT_DIALOG_NOT_FOUND', 'Диалог не найден')
    return json(res, 200, { ...listItem(dialog), messages: dialog.messages })
  }

  // POST /v1/users/{userId}/dialogs/{dialogId}/recap - the closing sheet's recap; ends and stores nothing
  if (parts.length === 6 && parts[5] === 'recap' && method === 'POST') {
    if (!dialog) return agentError(res, 404, 'AGENT_DIALOG_NOT_FOUND', 'Диалог не найден')
    return json(res, 200, { recap: buildRecap(dialog) })
  }

  // POST /v1/users/{userId}/dialogs/{dialogId}/end
  if (parts.length === 6 && parts[5] === 'end' && method === 'POST') {
    if (!dialog) return agentError(res, 404, 'AGENT_DIALOG_NOT_FOUND', 'Диалог не найден')
    const body = await readBody(req)
    endDialog(dialog, body.takeaway ?? null, body.tensionAfter ?? null)
    return json(res, 200, { summary: dialog.summary })
  }

  return json(res, 404, { error: 'not_found' })
})

// ─── WebSocket ────────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true })

const TTS_RATE = 24_000
/** 200 ms of speech per frame. */
const TTS_FRAME_SAMPLES = TTS_RATE / 5
/** Frames leave twice as fast as they play, the way a synthesizer runs ahead of the listener. */
const TTS_FRAME_INTERVAL_MS = 100

/** TTS frame: kind 0x02, sequence number, PCM16 little-endian. */
function ttsFrame(sequence, samples) {
  const buffer = Buffer.alloc(5 + samples.length * 2)
  buffer.writeUInt8(0x02, 0)
  buffer.writeUInt32BE(sequence, 1)
  for (let i = 0; i < samples.length; i++) buffer.writeInt16LE(samples[i], 5 + i * 2)
  return buffer
}

/** Linear resampling: plenty for a stand-in voice. */
function resample(samples, from, to) {
  if (from === to) return samples
  const out = new Int16Array(Math.floor((samples.length * to) / from))
  for (let i = 0; i < out.length; i++) {
    const position = (i * from) / to
    const index = Math.floor(position)
    const next = samples[Math.min(index + 1, samples.length - 1)]
    out[i] = Math.round(samples[index] + (next - samples[index]) * (position - index))
  }
  return out
}

/** espeak-ng writes a 16-bit mono WAV to stdout; its data chunk may announce an unknown length, so it is read to the end. */
function pcmFromWav(wav) {
  const rate = wav.readUInt32LE(24)
  let offset = 12
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    if (id === 'data') {
      const start = offset + 8
      const end = size === 0xffffffff || start + size > wav.length ? wav.length : start + size
      const samples = new Int16Array(Math.floor((end - start) / 2))
      for (let i = 0; i < samples.length; i++) samples[i] = wav.readInt16LE(start + i * 2)
      return resample(samples, rate, TTS_RATE)
    }
    offset += 8 + size
  }
  return new Int16Array(0)
}

async function synthesize(sentence) {
  const { stdout } = await run('espeak-ng', ['-v', 'ru', '-s', '150', '--stdout', sentence], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  })
  return pcmFromWav(stdout)
}

function sentencesOf(text) {
  return text.match(/[^.!?…]+[.!?…]*/g)?.map((part) => part.trim()).filter(Boolean) ?? []
}

/** The audio of a reply, a frame at a time: sentence by sentence, so the first sound is not held up by the last one. */
async function* speechFrames(mode, text) {
  if (mode === 'beep') {
    for (let n = 0; n < 3; n++) {
      yield Int16Array.from({ length: TTS_FRAME_SAMPLES }, (_, i) => Math.round(Math.sin((2 * Math.PI * 220 * i) / TTS_RATE) * 2000))
    }
    return
  }
  for (const sentence of sentencesOf(text)) {
    const pcm = await synthesize(sentence)
    for (let at = 0; at < pcm.length; at += TTS_FRAME_SAMPLES) yield pcm.subarray(at, at + TTS_FRAME_SAMPLES)
  }
}

/**
 * Voices `text` as the message `messageId`: tts_start, binary frames, tts_end. Starts at once and does
 * not wait for the text to finish. The person talking over it (`tts_cancel`) stops the frames.
 */
async function speak(socket, messageId, text) {
  const mode = effectiveTts()
  if (mode === 'none' || !text) return
  send(socket, { type: 'tts_start', messageId })
  let sequence = 0
  try {
    for await (const samples of speechFrames(mode, text)) {
      if (socket.readyState !== socket.OPEN || socket.cancelledSpeech.has(messageId)) break
      socket.send(ttsFrame(sequence++, samples))
      await new Promise((resolve) => setTimeout(resolve, TTS_FRAME_INTERVAL_MS))
    }
  } catch (error) {
    console.log(`[agent-mock] синтез не удался: ${error.message}`)
  }
  send(socket, { type: 'tts_end', messageId })
}

function send(socket, frame) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ v: 1, ...frame }))
}

const STREAM_DELAY_MS = 60

async function streamAssistantReply(socket, dialog, crisis = false) {
  const text = crisis
    ? 'Я слышу, что тебе очень тяжело. Ты не один на один с этим. Давай посмотрим, кому можно позвонить прямо сейчас.'
    : nextReply(dialog)
  const message = addMessage(dialog, 'assistant', text)

  send(socket, { type: 'assistant_start', messageId: message.id })
  // The voice starts with the text, not after it: a real agent speaks the first sentence while the rest is written.
  const speech = speak(socket, message.id, text)
  const words = text.split(' ')
  for (const word of words) {
    await new Promise((resolve) => setTimeout(resolve, STREAM_DELAY_MS))
    if (socket.readyState !== socket.OPEN) return
    send(socket, { type: 'assistant_delta', messageId: message.id, text: `${word} ` })
  }
  send(socket, { type: 'assistant_end', messageId: message.id, text })
  await speech
}

wss.on('connection', (socket, request, context) => {
  const { dialog } = context
  console.log(`[agent-mock] сокет открыт: диалог ${dialog.dialogId}`)
  /** Messages whose speech the client cancelled (it started talking over them). */
  socket.cancelledSpeech = new Set()
  send(socket, { type: 'ready' })
  // The greeting came over REST as text; the agent also says it, under the reserved id "greeting".
  if (dialog.greetingPending && dialog.greeting) {
    dialog.greetingPending = false
    void speak(socket, 'greeting', dialog.greeting)
  }

  /** The person's audio frames: we count them and emit "recognized" text after a pause. */
  let audioFrames = 0
  let audioTimer = null

  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      audioFrames += 1
      clearTimeout(audioTimer)
      // A real ASR finalizes on silence; here it is a pause in the frames.
      audioTimer = setTimeout(() => {
        const seconds = Math.max(1, Math.round((audioFrames * 100) / 1000))
        const text = `[голосовая реплика, ${seconds} с]`
        const message = addMessage(dialog, 'user', text)
        audioFrames = 0
        // A voice turn is not acknowledged: the final transcript carries the id of the stored message.
        send(socket, { type: 'transcript', text, final: true, messageId: message.id })
        void streamAssistantReply(socket, dialog)
      }, 700)
      return
    }

    let frame
    try {
      frame = JSON.parse(data.toString())
    } catch {
      return send(socket, { type: 'error', code: 'BAD_FRAME', message: 'not a json frame' })
    }

    switch (frame.type) {
      case 'user_message': {
        // A client repeats what it never saw acknowledged: the same id is the same message.
        dialog.clientIds ??= new Map()
        const repeated = frame.id ? dialog.clientIds.get(frame.id) : undefined
        if (repeated) {
          send(socket, { type: 'ack', id: frame.id, messageId: repeated })
          return
        }
        const text = String(frame.text ?? '')
        const crisis = isCrisis(text)
        const message = addMessage(dialog, 'user', text)
        if (frame.id) dialog.clientIds.set(frame.id, message.id)
        send(socket, { type: 'ack', id: frame.id ?? message.id, messageId: message.id })
        // Help is needed now: the app shows its own helplines under the agent's words.
        if (crisis) {
          dialog.crisisSeen = true
          send(socket, { type: 'safety', text: 'Если тебе сейчас опасно — позвони по одному из номеров ниже.' })
        }
        void streamAssistantReply(socket, dialog, crisis)
        return
      }
      case 'audio_start':
        audioFrames = 0
        return
      case 'audio_end':
        return
      case 'tts_cancel':
        if (typeof frame.messageId === 'string') socket.cancelledSpeech.add(frame.messageId)
        return
      case 'end': {
        endDialog(dialog, frame.takeaway ?? null, frame.tensionAfter ?? null)
        send(socket, { type: 'ended', summary: dialog.summary })
        socket.close(1000, 'dialog ended')
        return
      }
      default:
        return send(socket, { type: 'error', code: 'UNKNOWN_FRAME', message: String(frame.type) })
    }
  })

  socket.on('close', () => {
    clearTimeout(audioTimer)
    console.log(`[agent-mock] сокет закрыт: диалог ${dialog.dialogId}`)
  })
})

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  const parts = url.pathname.split('/').filter(Boolean)
  // /v1/users/{userId}/dialogs/{dialogId}/ws
  const looksRight =
    parts[0] === 'v1' && parts[1] === 'users' && parts[3] === 'dialogs' && parts[5] === 'ws' && parts.length === 6
  if (!looksRight) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    return socket.destroy()
  }
  const userId = decodeURIComponent(parts[2])
  const dialog = userState(userId).dialogs.get(decodeURIComponent(parts[4]))
  if (!dialog) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    return socket.destroy()
  }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request, { dialog }))
})

server.listen(PORT, () => {
  console.log(`[agent-mock] слушает http://localhost:${PORT} (REST + WebSocket)`)
})
