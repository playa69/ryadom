/**
 * Dialogs: REST and the WebSocket gateway against an agent started inside the test.
 */
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import {
  DialogApiErrorCode,
  DialogClientFrame,
  DialogCloseCode,
  DialogMode,
  DialogServerFrame,
  DialogWsErrorCode,
  SafetyLevel,
  type ListDialogsApiResponse,
  type StartDialogApiResponse,
} from '@ryadom/contracts/api/dialogs'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { closeAllDialogSessions, handleDialogSocket } from '../src/dialogs/gateway'
import { resetDraining, startDraining } from '../src/lib/lifecycle'
import { createJwt } from '../src/lib/jwt'
import { parseEnv } from '../src/lib/env'
import { call, json, makeApp, mockAgent, ok, refusedWith, signUpAndIn } from './helpers'

const { app, resetLimits } = makeApp()

describe('REST диалогов', () => {
  it('старт ничего о режиме и клиенте агенту не передаёт, отвечает диалогом', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)
    const { calls } = mockAgent({
      'POST http://agent.test/v1/users/*/dialogs': () =>
        json({ dialogId: 'd-7', resumed: true, greeting: 'Продолжим?', sinceLastDialogHours: 48 }),
    })

    const started = ok<StartDialogApiResponse>(
      await call(app, 'POST', '/api/dialogs', { mode: DialogMode.Vent }, tokens.accessToken, {
        'X-Platform': 'android',
        'X-App-Version': '12',
      }),
    )
    expect(started).toEqual({ dialogId: 'd-7', resumed: true, greeting: 'Продолжим?', sinceLastDialogHours: 48 })

    const agentCall = calls.at(-1)!
    expect(agentCall.url.pathname).toBe(`/v1/users/${user.id}/dialogs`)
    expect(agentCall.body).toBe('')
  })

  it('старый клиент шлёт режим, новый нет — оба получают диалог', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    mockAgent({
      'POST http://agent.test/v1/users/*/dialogs': () => json({ dialogId: 'd-8', resumed: false }),
    })

    for (const body of [{ mode: DialogMode.Vent }, {}]) {
      const started = ok<StartDialogApiResponse>(await call(app, 'POST', '/api/dialogs', body, tokens.accessToken))
      expect(started).toMatchObject({ dialogId: 'd-8', resumed: false })
    }
  })

  it('журнал отдаёт даты строками ISO', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    mockAgent({
      'GET http://agent.test/v1/users/*/dialogs': () =>
        json({
          items: [
            {
              dialogId: 'd-1',
              mode: 'vent',
              startedAt: '2026-10-01T20:00:00.000Z',
              endedAt: null,
              summary: { title: 'Про работу', themes: ['работа'], tensionBefore: 7, tensionAfter: 4 },
            },
          ],
          next: null,
        }),
    })

    const listed = ok<ListDialogsApiResponse>(await call(app, 'GET', '/api/dialogs', undefined, tokens.accessToken))
    expect(listed.items[0]).toMatchObject({
      dialogId: 'd-1',
      startedAt: '2026-10-01T20:00:00.000Z',
      endedAt: null,
      summary: { title: 'Про работу', tensionAfter: 4 },
    })
  })

  it('чужой диалог — DIALOG_NOT_FOUND; агент лёг — 503', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    mockAgent({ 'GET http://agent.test/v1/users/*/dialogs/*': () => json({ error: 'not_found' }, 404) })
    refusedWith(
      await call(app, 'GET', '/api/dialogs/d-x', undefined, tokens.accessToken),
      DialogApiErrorCode.DIALOG_NOT_FOUND,
    )

    mockAgent({ 'GET http://agent.test/v1/users/*/dialogs/*': () => json({ error: 'boom' }, 502) })
    const response = await app.request('/api/dialogs/d-x', { headers: { Authorization: `Bearer ${tokens.accessToken}` } })
    expect(response.status).toBe(503)
  })

  it('без токена — 401', async () => {
    const response = await app.request('/api/dialogs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: DialogMode.Vent }),
    })
    expect(response.status).toBe(401)
  })
})

// ─── WebSocket gateway ────────────────────────────────────────────────────────

interface AgentConnection {
  socket: WebSocket
  received: unknown[]
  binaryFrames: Buffer[]
}

interface FakeAgent {
  url: string
  /** Connection by dialog id: each test has its own, so tests do not interfere with each other. */
  waitFor: (dialogId: string) => Promise<AgentConnection>
  close: () => Promise<void>
}

/**
 * A tiny WebSocket agent: it accepts frames at the user-scoped address and lets the test answer with
 * its own. Connections are keyed by dialog, otherwise a test would answer into the previous test's
 * socket.
 */
async function startFakeAgent(): Promise<FakeAgent> {
  const server = createServer()
  const wss = new WebSocketServer({ server })
  const connections = new Map<string, AgentConnection>()

  wss.on('connection', (socket, request) => {
    // /v1/users/{userId}/dialogs/{dialogId}/ws
    const parts = (request.url ?? '').split('?')[0]!.split('/').filter(Boolean)
    const dialogId = decodeURIComponent(parts[4] ?? '')
    const connection: AgentConnection = {
      socket: socket as unknown as WebSocket,
      received: [],
      binaryFrames: [],
    }
    connections.set(dialogId, connection)
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) connection.binaryFrames.push(data)
      else connection.received.push(JSON.parse(data.toString('utf8')))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    async waitFor(dialogId) {
      await vi.waitFor(() => expect(connections.has(dialogId)).toBe(true), { timeout: 5000 })
      return connections.get(dialogId)!
    },
    close: () =>
      new Promise<void>((resolve) => {
        // terminate rather than close: otherwise wss.close waits for clients and the hook times out.
        for (const connection of connections.values()) connection.socket.terminate()
        wss.close(() => server.close(() => resolve()))
      }),
  }
}

/** The app with WebSocket: as in production, the upgrade is intercepted before Hono. */
async function startGatewayServer(agentUrl: string) {
  // The agent address reaches the gateway through the app env rather than the core's getEnv():
  // otherwise clearing the stubs in setup.ts between tests would point the socket at the real address.
  const env = parseEnv({ ...process.env, AGENT_API_URL: agentUrl })
  const { app: hono } = makeApp({ env: { AGENT_API_URL: agentUrl } })
  const jwt = createJwt(env.MOBILE_JWT_SECRET)

  const server = serve({ fetch: hono.fetch, port: 0, createServer }) as unknown as Server
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    if ((request.url ?? '').split('?')[0] !== ApiPath.DialogsWs) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => handleDialogSocket(ws as never, { env, jwt }))
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 50))
  const { port } = server.address() as AddressInfo
  return {
    wsUrl: `ws://127.0.0.1:${port}${ApiPath.DialogsWs}`,
    jwt,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => server.close(() => resolve()))
      }),
  }
}

function nextFrame(socket: WebSocket, type?: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no frame ${type ?? ''} in ${timeoutMs} ms`)), timeoutMs)
    const onMessage = (data: Buffer, isBinary: boolean) => {
      if (isBinary) return
      const frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>
      if (type && frame.type !== type) return
      clearTimeout(timer)
      socket.off('message', onMessage)
      resolve(frame)
    }
    socket.on('message', onMessage)
  })
}

function waitOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
}

describe('WebSocket-шлюз', () => {
  let agent: FakeAgent
  let gateway: Awaited<ReturnType<typeof startGatewayServer>>

  beforeAll(async () => {
    agent = await startFakeAgent()
    gateway = await startGatewayServer(agent.url)
  })

  afterAll(async () => {
    await gateway.close()
    await agent.close()
  })

  it('hello с токеном открывает диалог и пропускает кадры в обе стороны', async () => {
    const userId = '11111111-1111-4111-8111-111111111111'
    const { accessToken } = await gateway.jwt.issueTokenPair(userId)
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)

    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-1' }))
    const agentSide = await agent.waitFor('d-1')
    agentSide.socket.send(JSON.stringify({ type: 'ready', greeting: 'Я рядом.' }))

    const ready = await nextFrame(client, DialogServerFrame.Ready)
    expect(ready).toMatchObject({ v: 1, dialogId: 'd-1', greeting: 'Я рядом.' })

    client.send(JSON.stringify({ type: DialogClientFrame.Message, clientId: 'c-1', text: 'тяжело' }))
    await vi.waitFor(() =>
      expect(agentSide.received).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'user_message', id: 'c-1', text: 'тяжело' })]),
      ),
    )

    agentSide.socket.send(JSON.stringify({ type: 'ack', id: 'c-1', messageId: 'm-1' }))
    expect(await nextFrame(client, DialogServerFrame.Ack)).toMatchObject({ clientId: 'c-1', messageId: 'm-1' })

    client.close()
  })

  it('кадр safety без линий помощи дополняется нашими', async () => {
    const userId = '22222222-2222-4222-8222-222222222222'
    const { accessToken } = await gateway.jwt.issueTokenPair(userId)
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-2' }))
    const agentSide = await agent.waitFor('d-2')

    agentSide.socket.send(JSON.stringify({ type: 'safety', level: 'crisis', text: 'я рядом' }))
    const safety = await nextFrame(client, DialogServerFrame.Safety)
    expect(safety.level).toBe(SafetyLevel.Crisis)
    // The SOS screen must not open empty even when the agent supplied no hotlines.
    expect((safety.hotlines as unknown[]).length).toBeGreaterThan(0)

    client.close()
  })

  it('без hello соединение закрывается как неавторизованное', async () => {
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Message, clientId: 'c-1', text: 'привет' }))

    const error = await nextFrame(client, DialogServerFrame.Error)
    expect(error.code).toBe(DialogWsErrorCode.UNAUTHORIZED)
    const code = await new Promise<number>((resolve) => client.once('close', resolve))
    expect(code).toBe(DialogCloseCode.Unauthorized)
  })

  it('битый токен — UNAUTHORIZED', async () => {
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: 'garbage', dialogId: 'd-3' }))
    const error = await nextFrame(client, DialogServerFrame.Error)
    expect(error.code).toBe(DialogWsErrorCode.UNAUTHORIZED)
  })

  it('слишком длинная реплика отклоняется, соединение живёт', async () => {
    const userId = '33333333-3333-4333-8333-333333333333'
    const { accessToken } = await gateway.jwt.issueTokenPair(userId)
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-4' }))
    await agent.waitFor('d-4')

    client.send(JSON.stringify({ type: DialogClientFrame.Message, clientId: 'c-x', text: 'x'.repeat(5000) }))
    const error = await nextFrame(client, DialogServerFrame.Error)
    expect(error.code).toBe(DialogWsErrorCode.MESSAGE_TOO_LONG)
    expect(client.readyState).toBe(WebSocket.OPEN)

    client.close()
  })

  it('второе соединение того же человека закрывает первое', async () => {
    const userId = '44444444-4444-4444-8444-444444444444'
    const { accessToken } = await gateway.jwt.issueTokenPair(userId)
    const first = new WebSocket(gateway.wsUrl)
    await waitOpen(first)
    first.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-5' }))
    await agent.waitFor('d-5')

    const closed = new Promise<number>((resolve) => first.once('close', resolve))
    const second = new WebSocket(gateway.wsUrl)
    await waitOpen(second)
    second.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-5' }))

    expect(await closed).toBe(DialogCloseCode.Superseded)
    second.close()
  })

  it('бинарные кадры аудио идут агенту как есть', async () => {
    const userId = '55555555-5555-4555-8555-555555555555'
    const { accessToken } = await gateway.jwt.issueTokenPair(userId)
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-6' }))
    const agentSide = await agent.waitFor('d-6')

    const frame = Buffer.alloc(325)
    frame.writeUInt8(0x01, 0)
    frame.writeUInt32BE(1, 1)
    client.send(frame)

    await vi.waitFor(() => expect(agentSide.binaryFrames.length).toBeGreaterThan(0))
    expect(agentSide.binaryFrames.at(-1)!.readUInt8(0)).toBe(0x01)

    client.close()
  })

  it('пока под останавливают, новый сокет отвергается сразу кодом 1012', async () => {
    startDraining()
    try {
      const client = new WebSocket(gateway.wsUrl)
      const code = await new Promise<number>((resolve) => client.once('close', resolve))
      expect(code).toBe(DialogCloseCode.Restarting)
    } finally {
      resetDraining()
    }
  })

  it('перекат закрывает все диалоги кодом 1012, растянув закрытие во времени', async () => {
    const clients: WebSocket[] = []
    for (const [index, userId] of [
      '88888888-8888-4888-8888-888888888881',
      '88888888-8888-4888-8888-888888888882',
      '88888888-8888-4888-8888-888888888883',
    ].entries()) {
      const { accessToken } = await gateway.jwt.issueTokenPair(userId)
      const client = new WebSocket(gateway.wsUrl)
      await waitOpen(client)
      client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: `d-roll-${index}` }))
      await agent.waitFor(`d-roll-${index}`)
      clients.push(client)
    }

    const closedAt: number[] = []
    const started = Date.now()
    const closing = clients.map(
      (client) =>
        new Promise<number>((resolve) =>
          client.once('close', (code) => {
            closedAt.push(Date.now() - started)
            resolve(code)
          }),
        ),
    )
    closeAllDialogSessions(600)
    // All three got the code, and none later than the spread allows.
    const codes = await Promise.all(closing)
    expect(codes).toEqual([DialogCloseCode.Restarting, DialogCloseCode.Restarting, DialogCloseCode.Restarting])
    expect(Math.max(...closedAt)).toBeLessThan(1500)
  })

  /** A 100 ms microphone frame: kind byte, sequence number, then samples. */
  function micFrame(sequence: number): Buffer {
    const frame = Buffer.alloc(3205)
    frame.writeUInt8(0x01, 0)
    frame.writeUInt32BE(sequence, 1)
    return frame
  }

  it('долгая реплика и всплеск кадров после подвисания не рвут соединение', async () => {
    const userId = '66666666-6666-4666-8666-666666666666'
    const { accessToken } = await gateway.jwt.issueTokenPair(userId)
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-7' }))
    const agentSide = await agent.waitFor('d-7')

    client.send(JSON.stringify({ type: DialogClientFrame.AudioStart, sampleRate: 16000 }))
    // Four seconds of speech arriving at once: the count used to be per utterance, so anything
    // longer than two seconds cut the connection.
    for (let sequence = 0; sequence < 40; sequence++) client.send(micFrame(sequence))

    await vi.waitFor(() => expect(agentSide.binaryFrames).toHaveLength(40))
    expect(client.readyState).toBe(WebSocket.OPEN)

    client.close()
  })

  it('поток кадров быстрее, чем говорит человек, — RATE_LIMITED', async () => {
    const userId = '77777777-7777-4777-8777-777777777777'
    const { accessToken } = await gateway.jwt.issueTokenPair(userId)
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-8' }))
    await agent.waitFor('d-8')

    const closed = new Promise<number>((resolve) => client.once('close', resolve))
    client.send(JSON.stringify({ type: DialogClientFrame.AudioStart, sampleRate: 16000 }))
    for (let sequence = 0; sequence < 200; sequence++) client.send(micFrame(sequence))

    expect((await nextFrame(client, DialogServerFrame.Error)).code).toBe(DialogWsErrorCode.RATE_LIMITED)
    expect(await closed).toBe(DialogCloseCode.RateLimited)
  })
})
