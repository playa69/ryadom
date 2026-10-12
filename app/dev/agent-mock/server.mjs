#!/usr/bin/env node
/**
 * `agent-api` mock for local development.
 *
 * It implements exactly the contract our gateway expects: REST to start a dialog, to read the
 * journal, to end a dialog and to erase data, plus a per-dialog WebSocket that streams the reply.
 * Dialogs live in process memory and disappear on restart - this is a mock, not a service.
 *
 * What is not here and must not be: real models, memory across sessions, classifiers. Crisis is
 * detected from a word list and speech "recognition" returns a stub with the duration. Speech
 * output is real: replies (and the greeting) are synthesized by espeak-ng and streamed as 24 kHz
 * PCM16 frames, the way the real agent will stream its TTS. See `MOCK_TTS` below.
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

/** userId → { dialogs: Map<dialogId, dialog> } */
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
  if (!users.has(userId)) users.set(userId, { dialogs: new Map() })
  return users.get(userId)
}

function openDialogOf(userId) {
  for (const dialog of userState(userId).dialogs.values()) {
    if (!dialog.endedAt) return dialog
  }
  return null
}

function createDialog(userId) {
  const dialog = {
    dialogId: randomUUID(),
    userId,
    startedAt: new Date().toISOString(),
    endedAt: null,
    summary: null,
    messages: [],
    replyIndex: 0,
  }
  userState(userId).dialogs.set(dialog.dialogId, dialog)
  return dialog
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
  // summary, messages: [{ role, text }] }] }, messages get their times spread from startedAt.
  if (parts.length === 4 && parts[3] === 'seed' && method === 'POST') {
    const body = await readBody(req)
    const state = userState(userId)
    state.dialogs.clear()
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
      }
      state.dialogs.set(dialog.dialogId, dialog)
    }
    return json(res, 200, { count: state.dialogs.size })
  }

  if (parts[3] !== 'dialogs') return json(res, 404, { error: 'not_found' })

  // POST /v1/users/{userId}/dialogs - start a dialog or return the open one. A plain start changes
  // nothing (the open dialog comes back `resumed`, with its message count and last activity, so the app
  // can ask the person). `{ new: true }` asks for a fresh conversation: the open one is ended first and
  // stays in the journal, unless it is empty, then it is simply reused; the answer is never `resumed`.
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
        existing.endedAt = new Date().toISOString()
        existing.summary = buildSummary(existing, null, null)
        existing = null
      }
    }
    const dialog = existing ?? createDialog(userId)
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
    if (!dialog) return json(res, 404, { error: 'dialog_not_found' })
    return json(res, 200, { ...listItem(dialog), messages: dialog.messages })
  }

  // POST /v1/users/{userId}/dialogs/{dialogId}/end
  if (parts.length === 6 && parts[5] === 'end' && method === 'POST') {
    if (!dialog) return json(res, 404, { error: 'dialog_not_found' })
    const body = await readBody(req)
    dialog.endedAt = new Date().toISOString()
    dialog.summary = buildSummary(dialog, body.takeaway ?? null, body.tensionAfter ?? null)
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
        dialog.endedAt = new Date().toISOString()
        dialog.summary = buildSummary(dialog, frame.takeaway ?? null, frame.tensionAfter ?? null)
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
