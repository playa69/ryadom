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
import { handleMemory as handleNotesMemory, newMemory, onUserMessage, seedMemory } from './memory-notes.mjs'
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
/** `POST /dev/digests {"fail": true}` makes `/digests` answer 502, as an agent whose model is down. */
let digestsFail = false
let memoryMode = MEMORY_MODES.includes(process.env.MOCK_MEMORY_MODE) ? process.env.MOCK_MEMORY_MODE : 'on'
const MEMORY_ALLOWLIST = (process.env.MOCK_MEMORY_ALLOWLIST ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean)
const MEMORY_DELAY_MS = Number(process.env.MOCK_MEMORY_DELAY_MS ?? 1500)
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
  if (!users.has(userId)) users.set(userId, { dialogs: new Map(), memory: newMemory(), recapEnabled: true })
  return users.get(userId)
}

// ─── Recaps of conversations (add-mood-diary D13) ─────────────────────────────
// A recap is one free-form text in the second person (the «Что забираешь с собой» field is the recap). The mock follows the real agent's rules: none for a conversation where the
// person said under 40 characters, for one with a crisis, or one held «without memory»; a recap the person wrote is kept
// as it is and the automatic one never replaces it; the automatic one is ready after MOCK_RECAP_DELAY_MS (pending until then).
const RECAP_DELAY_MS = Number(process.env.MOCK_RECAP_DELAY_MS ?? 3000)
const RECAP_MIN_USER_CHARS = 40

function userChars(dialog) {
  return dialog.messages.filter((m) => m.role === 'user').reduce((sum, m) => sum + m.text.trim().length, 0)
}

function recapEligible(dialog) {
  return dialog.memoryMode !== 'off' && !dialog.crisisSeen && userChars(dialog) >= RECAP_MIN_USER_CHARS
}

function templateRecap(dialog) {
  const said = dialog.messages.filter((m) => m.role === 'user').map((m) => m.text.trim())
  const snippet = (said[0] ?? '').replace(/[.!?…]+$/, '').slice(0, 120)
  const agreement = said.map((t) => /давай так:?\s*(.+)/i.exec(t)?.[1]).find(Boolean)
  return (
    `Ты рассказал, что у тебя на душе${snippet ? `: ${snippet}` : ''}. Тебе важно, чтобы тебя услышали.` +
    (agreement ? ` Ты решил: ${agreement.replace(/[.!?…]+$/, '').slice(0, 120)}.` : '')
  )
}

function cleanRecap(value) {
  if (typeof value !== 'string') return null
  const text = value.trim().replace(/\s+/g, ' ')
  return text && text.length <= 500 ? text : null
}

function storeRecap(dialog, recap, source) {
  dialog.summary.recap = recap
  dialog.summary.recapStatus = 'ready'
  dialog.summary.recapSource = source
  dialog.summary.recapAt = new Date().toISOString()
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

/** Ends the dialog and starts its recap: written by the person, or the automatic one after `RECAP_DELAY_MS`. */
function endDialog(dialog, takeaway, tensionAfter, recapSource = 'manual') {
  dialog.endedAt = new Date().toISOString()
  dialog.summary = {
    ...buildSummary(dialog, takeaway, tensionAfter),
    recap: null,
    recapStatus: 'none',
    recapSource: null,
    recapAvailable: recapEligible(dialog),
  }
  const written = cleanRecap(takeaway)
  if (recapEligible(dialog)) {
    if (written) storeRecap(dialog, written, recapSource === 'draft' ? 'draft' : 'manual')
    else if (userState(dialog.userId).recapEnabled) {
      dialog.summary.recapStatus = 'pending'
      setTimeout(() => {
        // The person may have written one meanwhile, or deleted the conversation.
        if (dialog.summary?.recapStatus === 'pending') storeRecap(dialog, templateRecap(dialog), 'auto')
      }, RECAP_DELAY_MS)
    }
  }
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
    // `saved: false` marks a conversation the person asked not to keep: only the mark is listed (add-unsaved-dialog).
    saved: dialog.saved !== false,
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
  if (role === 'user') onUserMessage(userState(dialog.userId).memory, dialog, text, memoryAvailable())
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

/** /v1/users/{userId}/memory...: the notes model lives in `memory-notes.mjs`. */
function handleMemoryRoute(req, res, url, userId, parts, method) {
  return handleNotesMemory(
    { json, noContent, readBody, agentError, available: memoryAvailable, mode: () => memoryMode, allowlist: MEMORY_ALLOWLIST },
    req,
    res,
    url,
    userId,
    userState(userId).memory,
    parts,
    method,
  )
}

function memoryAvailable() {
  return memoryMode !== 'off'
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

  // Dev only: switch the digests route into failure and back.
  if (path === '/dev/digests' && method === 'POST') {
    const body = await readBody(req)
    digestsFail = body.fail === true
    return json(res, 200, { fail: digestsFail })
  }

  // /v1/users/{userId}...
  const parts = path.split('/').filter(Boolean)
  if (parts[0] !== 'v1' || parts[1] !== 'users' || !parts[2]) return json(res, 404, { error: 'not_found' })
  const userId = decodeURIComponent(parts[2])

  // POST /v1/users/{userId}/digests - the text of a week summary or a year story. The real agent asks the
  // model; the mock writes a fixed text from the marks, in the shape the spec asks for (the person's own
  // "ты", no scores, no "надо", no count of days in a row). It keeps nothing. `POST /dev/digests {fail: true}`
  // makes it answer 502 once more, for the "agent is down" screen.
  if (parts.length === 4 && parts[3] === 'digests' && method === 'POST') {
    const body = await readBody(req)
    if (digestsFail) return json(res, 502, { error: { code: 'DIGEST_UNAVAILABLE', message: 'mock: digests are down' } })
    const marks = Array.isArray(body.marks) ? body.marks : []
    const levels = ['тяжело', 'так себе', 'нормально', 'хорошо', 'отлично']
    const counts = [0, 0, 0, 0, 0]
    for (const mark of marks) if (mark?.mood >= 1 && mark.mood <= 5) counts[mark.mood - 1] += 1
    let top = 2
    counts.forEach((count, i) => { if (count > 0 && count >= counts[top]) top = i })
    const hard = counts[0]
    if (body.kind === 'year') {
      const weekly = Array.isArray(body.weekly) ? body.weekly.length : 0
      const text =
        `Этот год ты отмечал настроение ${marks.length} раз, и чаще всего оно было «${levels[top]}». ` +
        `За это время я собрал для тебя ${weekly} итогов недель. Были дни полегче и дни потяжелее, и это нормально. ` +
        'Рядом с тобой всегда можно поговорить, когда захочется.'
      return json(res, 200, { text, stats: { markedDays: marks.length } })
    }
    const recaps = Array.isArray(body.recaps) ? body.recaps : []
    // A general overview, no quotes and no tie to a dialog: only the names of the themes the recaps touch (as in agent/app/services/digests.py).
    const texts = recaps.map((r) => (typeof r?.text === 'string' ? r.text.trim() : '')).filter(Boolean)
    const joined = texts.join(' ').toLowerCase()
    const THEMES = [
      ['работа и дела', /работ|руковод|начальн|коллег|офис|проект|дедлайн|карьер|увольн/],
      ['близкие и отношения', /мам[аыуе]|пап|семь|друг|подруг|отношени|партн[её]р|муж|жена|девушк|парень|дет[иейям]/],
      ['здоровье и сон', /здоровь|сон\b|сна\b|бессонн|усталост|болезн|врач|тревог|паник/],
      ['деньги', /деньг|долг|зарплат|кредит|финанс/],
    ]
    const themes = THEMES.filter(([, re]) => re.test(joined)).map(([name]) => name).slice(0, 2)
    const text =
      (themes.length
        ? `На этой неделе в твоих мыслях заметное место занимало: ${themes.join(' и ')}. `
        : texts.length
          ? 'На этой неделе ты не раз возвращался к тому, что у тебя на душе. '
          : // Without recaps the mock states the counts, so that the e2e specs can tell a rewritten text from the old one.
            `Тяжёлых дней было ${hard}, лёгких — ${marks.filter((m) => m.mood >= 3).length}. `) +
      (hard >= 3
        ? 'Неделя выдалась непростой. Рядом могут быть люди, с которыми можно поговорить, и я тоже здесь.'
        : 'Спасибо, что делишься со мной тем, как ты.')
    return json(res, 200, { text, stats: { markedDays: marks.length, hardDays: hard } })
  }

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
    if (body.memory) state.memory = seedMemory(body.memory)
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
        // A conversation the person asked not to keep: only the mark exists, with no text and no recap.
        saved: item.saved === false ? false : undefined,
      }
      if (dialog.saved === false) dialog.messages = []
      state.dialogs.set(dialog.dialogId, dialog)
    }
    return json(res, 200, { count: state.dialogs.size, notes: state.memory.notes.size })
  }

  purgeIncognito(userId)

  if (parts[3] === 'memory') return handleMemoryRoute(req, res, url, userId, parts, method)

  // GET /v1/users/{userId}/recaps - conversations with a ready recap, newest first
  if (parts.length === 4 && parts[3] === 'recaps' && method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? 20)
    const items = [...userState(userId).dialogs.values()]
      .filter((d) => d.summary?.recapStatus === 'ready')
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, limit)
      .map((d) => ({
        dialogId: d.dialogId,
        startedAt: d.startedAt,
        endedAt: d.endedAt,
        title: d.summary.title,
        recap: d.summary.recap,
        recapSource: d.summary.recapSource,
        recapAt: d.summary.recapAt ?? null,
      }))
    return json(res, 200, { items, next: null })
  }

  // GET/PUT /v1/users/{userId}/dialog-settings - «Подводить итог автоматически», apart from the memory settings
  if (parts.length === 4 && parts[3] === 'dialog-settings') {
    const state = userState(userId)
    if (method === 'PUT') {
      const body = await readBody(req)
      if (typeof body.recapEnabled !== 'boolean') return agentError(res, 400, 'AGENT_VALIDATION', 'recapEnabled must be a boolean')
      state.recapEnabled = body.recapEnabled
    }
    return json(res, 200, { recapEnabled: state.recapEnabled })
  }

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

  // POST /v1/users/{userId}/dialogs/{dialogId}/end
  if (parts.length === 6 && parts[5] === 'end' && method === 'POST') {
    if (!dialog) return agentError(res, 404, 'AGENT_DIALOG_NOT_FOUND', 'Диалог не найден')
    const body = await readBody(req)
    if (dialog.summary) return json(res, 200, { summary: dialog.summary })
    endDialog(dialog, body.takeaway ?? null, body.tensionAfter ?? null, body.recapSource)
    return json(res, 200, { summary: dialog.summary })
  }

  // PUT /v1/users/{userId}/dialogs/{dialogId}/recap - the recap the person wrote in the journal
  if (parts.length === 6 && parts[5] === 'recap' && method === 'PUT') {
    if (!dialog) return agentError(res, 404, 'AGENT_DIALOG_NOT_FOUND', 'Диалог не найден')
    const body = await readBody(req)
    const written = cleanRecap(body.recap)
    if (!dialog.summary || !written || !recapEligible(dialog)) return agentError(res, 409, 'RECAP_NOT_AVAILABLE', 'Для этого разговора итога нет')
    storeRecap(dialog, written, body.source === 'draft' ? 'draft' : 'manual')
    return json(res, 200, { summary: dialog.summary })
  }

  // POST /v1/users/{userId}/dialogs/{dialogId}/recap/draft - a draft; nothing is stored
  if (parts.length === 7 && parts[5] === 'recap' && parts[6] === 'draft' && method === 'POST') {
    if (!dialog) return agentError(res, 404, 'AGENT_DIALOG_NOT_FOUND', 'Диалог не найден')
    if (!recapEligible(dialog)) return agentError(res, 409, 'RECAP_NOT_AVAILABLE', 'Для этого разговора итога нет')
    return json(res, 200, { recap: templateRecap(dialog) })
  }

  // DELETE /v1/users/{userId}/dialogs/{dialogId} - the conversation with its recap; the notes of memory stay
  if (parts.length === 5 && method === 'DELETE') {
    if (!dialog) return agentError(res, 404, 'AGENT_DIALOG_NOT_FOUND', 'Диалог не найден')
    userState(userId).dialogs.delete(dialog.dialogId)
    console.log(`[agent-mock] диалог удалён человеком ${dialog.dialogId}`)
    res.writeHead(204)
    return res.end()
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

/** The tone the real agent's classifier would report for a line (REQ-VOICE-10): a few words are enough for the mock. */
function moodOf(text) {
  if (/бесит|злюсь|достало|ненавижу/iu.test(text)) return { tone: 'angry', intensity: 0.8 }
  if (/спать|сонн|устал/iu.test(text)) return { tone: 'sleepy', intensity: 0.8 }
  if (/страшно|боюсь|тревожно/iu.test(text)) return { tone: 'afraid', intensity: 0.9 }
  return { tone: 'neutral', intensity: 0.1 }
}

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
        if (crisis) dialog.crisisSeen = true
        const message = addMessage(dialog, 'user', text)
        if (frame.id) dialog.clientIds.set(frame.id, message.id)
        send(socket, { type: 'ack', id: frame.id ?? message.id, messageId: message.id })
        send(socket, { type: 'mood', ...moodOf(text), at: Date.now() })
        // Help is needed now: the app shows its own helplines under the agent's words.
        if (crisis) {
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
        endDialog(dialog, frame.takeaway ?? null, frame.tensionAfter ?? null, frame.recapSource)
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
