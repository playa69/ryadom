import { randomUUID } from 'node:crypto'

/**
 * Memory of the agent mock: the notes model of PROTEUS-242 (`add-memory-notes`), the same routes and answers as the real agent,
 * with a rule-based "model" instead of a language one. Notes are short lines about the person in groups (`kind`); the person sees,
 * corrects and deletes each one; sensitive kinds (`wellbeing`, `beliefs`) are stored only while "Remember sensitive" is on.
 *
 * What it does, and how the real agent differs:
 * - "extraction" runs after `MOCK_NOTE_DELAY_MS` (1500) once the person says something in a conversation, with the memory on and the
 *   conversation not marked "without memory": a few phrase patterns ("меня зовут…", "работаю в…", "у меня есть сестра…", "люблю…",
 *   "не хочу говорить про…", "запомни…") become notes; "забудь про…" deletes the notes that mention it. The real agent asks a model.
 * - the final pass of the real agent (at the end of a conversation) is modelled as one more `MOCK_NOTE_DELAY_MS` after the end:
 *   `GET /memory/changes?dialogId=` answers `pending` until it and every pass still waiting are done, then `ready` with the notes whose
 *   source is that conversation, in the order they were said. A conversation "without memory", an unsaved one, memory off or paused:
 *   `ready` and nothing. A missing conversation: `404 AGENT_DIALOG_NOT_FOUND`.
 * - the checks of "never" (diagnoses, medicines, contacts, instructions to the agent) are a short list of the real one.
 * - nothing the person said ever reaches the log here: ids and counts only.
 */

const NOTE_KINDS = ['name', 'style', 'person', 'situation', 'event', 'agreement', 'interest', 'boundary', 'wellbeing', 'beliefs']
const SENSITIVE_KINDS = new Set(['wellbeing', 'beliefs'])
const NOTES_MAX = 200
const NOTE_DELAY_MS = Number(process.env.MOCK_NOTE_DELAY_MS ?? 1500)

/** Kind of a note → category of the old fact (for the legacy `facts` in `GET /memory`, which the cached apps read). */
const CATEGORY_OF_KIND = {
  name: 'style', style: 'style', person: 'person', situation: 'situation', event: 'situation', agreement: 'goal',
  interest: 'interest', boundary: 'boundary', wellbeing: 'situation', beliefs: 'situation',
}

/** What a note must never hold: code → pattern. */
const NEVER = [
  ['diagnosis', /диагноз|депресси|тревожн\w+ расстройств|биполяр|шизофрен|птср|сдвг|паническ\w+ атак/i],
  ['medication', /антидепрессант|таблетк|лекарств|препарат|сертралин|феназепам/i],
  ['self_harm', /суицид|самоубий|не хоч\w+ жить|хоч\w+ умереть|режет себя|убить себя/i],
  ['document', /паспорт|снилс|\bинн\b/i],
  ['payment', /номер карты|пароль|\bcvv\b/i],
  ['contact_pii', /\+?\d[\d\s().-]{8,}\d|[\w.+-]+@[\w-]+\.\w+|https?:\/\/|\bул(?:ица|\.)\s/i],
  ['label', /нарцисс|токсичн\w+ человек|психопат/i],
  ['instruction', /игнорир|всегда отвечай|отвечай\b|отвечать (?:только|всегда)/i],
]

export function newMemory() {
  return {
    enabled: false,
    consentVersion: null,
    consentAt: null,
    sensitiveEnabled: false,
    chatSearchEnabled: true,
    updatedAt: null,
    /** noteId → note in the shape of the API. */
    notes: new Map(),
  }
}

function now() {
  return new Date().toISOString()
}

function verdict(text, kind, memory) {
  const cleaned = String(text ?? '').trim()
  if (!cleaned) return 'empty'
  if (cleaned.length > 200) return 'too_long'
  if (!NOTE_KINDS.includes(kind)) return 'bad_kind'
  for (const [code, pattern] of NEVER) if (pattern.test(cleaned)) return code
  if (SENSITIVE_KINDS.has(kind) && !memory.sensitiveEnabled) return 'sensitive_off'
  return null
}

function addNote(memory, fields) {
  const at = now()
  const note = {
    id: randomUUID(),
    kind: fields.kind,
    text: String(fields.text).trim(),
    sensitive: SENSITIVE_KINDS.has(fields.kind),
    eventDate: fields.eventDate ?? null,
    createdAt: at,
    updatedAt: at,
    dialogId: fields.dialogId ?? null,
  }
  const same = [...memory.notes.values()].find((item) => item.text.toLowerCase() === note.text.toLowerCase())
  if (same) return same
  memory.notes.set(note.id, note)
  return note
}

function liveNotes(memory) {
  return [...memory.notes.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
}

function asFact(note) {
  return {
    id: note.id,
    category: CATEGORY_OF_KIND[note.kind] ?? 'situation',
    text: note.text,
    slots: null,
    importance: 5,
    confidence: 1,
    status: 'active',
    origin: 'user_edit',
    sensitivity: note.sensitive ? 'sensitive' : 'normal',
    sources: note.dialogId ? [{ dialogId: note.dialogId, date: note.createdAt.slice(0, 10) }] : [],
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    expiresAt: null,
    seenByUser: true,
  }
}

// ─── the "model": a few phrase patterns ───────────────────────────────────────

const STOP = new Set(['про', 'тему', 'это', 'что', 'мне', 'пожалуйста', 'тебя', 'моего', 'мою', 'моей', 'мой', 'меня', 'тоже', 'просто'])

/** The stems of the words of a request (first five letters, no stop-words): "про отца" finds "обсуждать отца". */
function stems(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !STOP.has(word))
    .map((word) => word.slice(0, Math.max(4, word.length - 2)))
}

function mentions(note, stemList) {
  const text = note.text.toLowerCase()
  return stemList.length > 0 && stemList.some((stem) => text.includes(stem))
}

/** Phrase → candidate notes `{ kind, text }`. */
function candidates(sentence) {
  const found = []
  const s = sentence.trim().replace(/[.!?]+$/, '')
  let m
  if ((m = /меня зовут ([А-ЯЁA-Z][\p{L}-]+)/iu.exec(s))) found.push({ kind: 'name', text: `Зовут ${cap(m[1])}` })
  if ((m = /(?:^|\s)(?:давай|давайте|можно) на (ты|вы)\b/i.exec(s))) found.push({ kind: 'style', text: `Просит обращаться на «${m[1].toLowerCase()}»` })
  if ((m = /(?:я )?работаю (в|на|с) ([^,.;]+)/i.exec(s))) found.push({ kind: 'situation', text: `Работает ${m[1]} ${m[2].trim()}` })
  if ((m = /у меня (?:есть )?(сестра|брат|мама|папа|муж|жена|дочь|сын|дочка|подруга|друг)\s+([А-ЯЁA-Z][\p{L}-]+)/iu.exec(s))) {
    found.push({ kind: 'person', text: `Есть ${m[1].toLowerCase()} ${cap(m[2])}` })
  }
  if ((m = /(?:я )?(?:люблю|обожаю|мне нравится) ([^,.;]+)/i.exec(s))) found.push({ kind: 'interest', text: `Любит ${m[1].trim()}` })
  if ((m = /не хочу (?:сегодня )?(?:говорить|обсуждать) (?:про|о|об) ([^,.;]+)/i.exec(s))) {
    found.push({ kind: 'boundary', text: `Не хочет обсуждать ${m[1].trim()}` })
  }
  if ((m = /плохо сплю|не могу уснуть|бессонниц/i.exec(s))) found.push({ kind: 'wellbeing', text: 'Последние недели плохо спит' })
  if ((m = /я верующ/i.exec(s))) found.push({ kind: 'beliefs', text: 'Верующий' })
  if ((m = /запомни,?\s*(?:что\s+)?(.+)/i.exec(s))) found.push({ kind: 'situation', text: cap(m[1].trim()) })
  return found
}

function cap(text) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * Carries out one sentence of the person: "забудь про…" deletes, "не X, а Y" corrects, the rest becomes notes.
 * Returns `{ added, updated, deleted, blocked }`; used by the conversation and by "Скажи, что поправить".
 */
function apply(memory, sentence, dialogId = null, explicit = true) {
  const out = { added: [], updated: [], deleted: [], blocked: [] }
  const s = sentence.trim()
  let m
  if (explicit && (m = /(?:забудь|убери|удали|не запоминай)\s+(.+)/i.exec(s))) {
    const list = stems(m[1])
    for (const note of liveNotes(memory)) {
      if (mentions(note, list)) {
        memory.notes.delete(note.id)
        out.deleted.push(note.id)
      }
    }
    return out
  }
  if (explicit && (m = /не ([\p{L}-]+),?\s+а ([\p{L}-]+)/iu.exec(s))) {
    const wrong = stems(m[1])
    for (const note of liveNotes(memory)) {
      if (mentions(note, wrong)) {
        const text = note.text.replace(new RegExp(m[1].slice(0, Math.max(3, m[1].length - 2)) + '[\\p{L}]*', 'iu'), m[2])
        if (verdict(text, note.kind, memory) === null) {
          note.text = text
          note.updatedAt = now()
          out.updated.push(note)
        }
      }
    }
    if (out.updated.length > 0) return out
  }
  for (const found of candidates(s)) {
    const reason = verdict(found.text, found.kind, memory)
    if (reason) {
      out.blocked.push(reason)
      continue
    }
    if (memory.notes.size >= NOTES_MAX) {
      out.blocked.push('full')
      continue
    }
    out.added.push(addNote(memory, { ...found, dialogId }))
  }
  return out
}

// ─── the hooks of the conversation ────────────────────────────────────────────

/** A person's line in a conversation: after a pause the "extraction" turns it into notes. */
export function onUserMessage(memory, dialog, text) {
  if (!memory.enabled || dialog.memoryMode === 'off') return
  dialog.pendingPasses = (dialog.pendingPasses ?? 0) + 1
  setTimeout(() => {
    dialog.pendingPasses -= 1
    if (!memory.enabled) return
    const out = apply(memory, text, dialog.dialogId, /(?:забудь|убери|удали|не запоминай|не [\p{L}-]+,?\s+а)/iu.test(text))
    console.log(`[agent-mock] заметки: +${out.added.length} ~${out.updated.length} -${out.deleted.length}`)
  }, NOTE_DELAY_MS)
}

/** The conversation has ended: the final pass runs for one more delay (a "without memory" or unsaved one has none, `ready` at once). */
export function onDialogEnded(memory, dialog) {
  if (!memory.enabled || dialog.memoryMode === 'off' || dialog.saved === false) return
  dialog.finalPassUntil = Date.now() + NOTE_DELAY_MS
}

/** The block "Я запомнил" of one conversation, as `GET /memory/changes` answers it. */
function changesOf(memory, dialog) {
  const ready = (items) => ({ status: 'ready', reason: null, items })
  if (dialog.memoryMode === 'off' || dialog.saved === false || !memory.enabled) return ready([])
  if (!dialog.endedAt || (dialog.pendingPasses ?? 0) > 0 || Date.now() < (dialog.finalPassUntil ?? 0)) {
    return { status: 'pending', reason: null, items: [] }
  }
  const mine = liveNotes(memory).filter((note) => note.dialogId === dialog.dialogId).reverse()
  return ready(mine.map((note) => ({ op: 'add', fact: asFact(note) })))
}

/**
 * Dev seed: `memory: { enabled, consentVersion?, sensitiveEnabled?, notes: [{ kind, text, eventDate? }] }`. A paused seed
 * (`enabled: false`) has a consent only when `consentVersion` is given: a pause keeps the consent, it never had one otherwise.
 */
export function seedMemory(body) {
  const memory = newMemory()
  const at = now()
  memory.enabled = body.enabled === true
  memory.consentVersion = body.consentVersion ?? (memory.enabled ? '2026-10-12' : null)
  memory.consentAt = memory.consentVersion ? at : null
  memory.sensitiveEnabled = body.sensitiveEnabled === true
  memory.updatedAt = at
  let offset = 0
  for (const item of body.notes ?? []) {
    if (!NOTE_KINDS.includes(item.kind) || typeof item.text !== 'string') continue
    const note = addNote(memory, { kind: item.kind, text: item.text, eventDate: item.eventDate ?? null })
    // spread the creation times so that the order of the list is the order of the seed
    note.createdAt = new Date(Date.parse(at) - offset * 60_000).toISOString()
    note.updatedAt = note.createdAt
    offset += 1
  }
  return memory
}

// ─── REST: /v1/users/{userId}/memory... ───────────────────────────────────────

function view(memory) {
  const notes = liveNotes(memory)
  return {
    available: true,
    mode: 'on', // kept for older clients, like the real agent
    enabled: memory.enabled,
    paused: !memory.enabled,
    sensitiveEnabled: memory.sensitiveEnabled,
    chatSearchEnabled: memory.chatSearchEnabled,
    consentVersion: memory.consentVersion,
    consentAt: memory.consentAt,
    rulesVersion: 'notes-1',
    limits: { maxFacts: NOTES_MAX, maxNotes: NOTES_MAX },
    notes,
    facts: notes.map(asFact),
  }
}

/**
 * `ctx`: `{ json, noContent, readBody, agentError, dialogOf }` of the mock server (`dialogOf(dialogId)` finds a dialog of this person).
 * Reading, export and deleting work with the memory off; writing notes needs it on.
 */
export async function handleMemory(ctx, req, res, url, userId, memory, parts, method) {
  const { json, noContent, readBody, agentError, dialogOf } = ctx
  const resource = parts[4] ?? null
  const id = parts[5] ?? null

  if (!resource && method === 'GET') return json(res, 200, view(memory))

  // DELETE /memory and DELETE /memory/notes: "delete all memory": the notes go, the switches and the consent stay
  if ((!resource || (resource === 'notes' && !id)) && method === 'DELETE') {
    const count = memory.notes.size
    memory.notes.clear()
    memory.updatedAt = now()
    console.log(`[agent-mock] память пользователя ${userId} стёрта, заметок было ${count}`)
    return noContent(res)
  }

  if (resource === 'settings' && parts.length === 5 && method === 'PUT') {
    const body = await readBody(req)
    const hasAny = ['enabled', 'sensitiveEnabled', 'chatSearchEnabled'].some((key) => typeof body[key] === 'boolean')
    if (!hasAny) return agentError(res, 400, 'AGENT_VALIDATION', 'Нечего менять')
    const at = now()
    if (body.enabled === true) {
      if (typeof body.consentVersion !== 'string' || !body.consentVersion) {
        return agentError(res, 422, 'AGENT_VALIDATION', 'Для включения нужна версия согласия')
      }
      memory.enabled = true
      // The same text accepted before the pause is not a new acceptance: the first date stays.
      if (memory.consentVersion !== body.consentVersion || !memory.consentAt) memory.consentAt = at
      memory.consentVersion = body.consentVersion
    } else if (body.enabled === false) {
      memory.enabled = false // a pause: the notes stay, the consent stays
    }
    if (typeof body.chatSearchEnabled === 'boolean') memory.chatSearchEnabled = body.chatSearchEnabled
    if (typeof body.sensitiveEnabled === 'boolean') {
      if (memory.sensitiveEnabled && !body.sensitiveEnabled) {
        for (const note of liveNotes(memory)) if (note.sensitive) memory.notes.delete(note.id)
      }
      memory.sensitiveEnabled = body.sensitiveEnabled
    }
    memory.updatedAt = at
    console.log(`[agent-mock] память пользователя ${userId}: ${memory.enabled ? 'включена' : 'на паузе'}`)
    return json(res, 200, {
      enabled: memory.enabled,
      sensitiveEnabled: memory.sensitiveEnabled,
      chatSearchEnabled: memory.chatSearchEnabled,
      consentVersion: memory.consentVersion,
      consentAt: memory.consentAt,
    })
  }

  if (resource === 'notes' && !id && method === 'GET') return json(res, 200, { notes: liveNotes(memory) })

  if (resource === 'notes' && id === 'instruction' && method === 'POST') {
    const body = await readBody(req)
    if (!memory.enabled) return agentError(res, 409, 'MEMORY_DISABLED', 'Память выключена')
    if (typeof body.text !== 'string' || !body.text.trim()) return agentError(res, 422, 'AGENT_VALIDATION', 'Нужен текст')
    return json(res, 200, { changes: apply(memory, body.text, null, true) })
  }

  if (resource === 'notes' && id && method === 'PATCH') {
    const body = await readBody(req)
    const note = memory.notes.get(id)
    if (!note) return agentError(res, 404, 'NOTE_NOT_FOUND', 'Заметка не найдена')
    const reason = verdict(body.text, note.kind, memory)
    if (reason) return agentError(res, 422, 'NOTE_REJECTED', 'Это нельзя запомнить', { reason })
    note.text = String(body.text).trim()
    note.updatedAt = now()
    return json(res, 200, note)
  }

  if (resource === 'notes' && id && method === 'DELETE') {
    if (!memory.notes.delete(id)) return agentError(res, 404, 'NOTE_NOT_FOUND', 'Заметка не найдена')
    return noContent(res)
  }

  // GET /memory/changes?dialogId=: the notes of one conversation, for the block "Я запомнил" in its closing window
  if (resource === 'changes' && method === 'GET') {
    const dialog = dialogOf(url.searchParams.get('dialogId') ?? '')
    if (!dialog) return agentError(res, 404, 'AGENT_DIALOG_NOT_FOUND', 'Диалог не найден')
    return json(res, 200, changesOf(memory, dialog))
  }

  if (resource === 'export' && method === 'GET') {
    return json(res, 200, {
      exportedAt: now(),
      rulesVersion: 'notes-1',
      settings: {
        enabled: memory.enabled,
        consentVersion: memory.consentVersion,
        consentAt: memory.consentAt,
        epochAt: null,
        updatedAt: memory.updatedAt,
      },
      notes: liveNotes(memory),
      facts: [],
      events: [],
    })
  }

  return agentError(res, 404, 'AGENT_VALIDATION', 'Нет такого маршрута памяти')
}
