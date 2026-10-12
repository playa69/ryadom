/**
 * Dialogs: REST and the WebSocket gateway against an agent started inside the test.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
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
import { createSessions } from '../src/lib/sessions'
import { parseEnv } from '../src/lib/env'
import {
  PASSWORD,
  call,
  json,
  makeApp,
  mockAgent,
  ok,
  recordingAnalytics,
  refusedWith,
  signUpAndIn,
} from './helpers'

const { app, resetLimits } = makeApp()

describe('REST диалогов', () => {
  it('старт передаёт агенту только голос человека (по умолчанию мужской), режим и клиента нет, отвечает диалогом с числом сообщений и временем последней активности', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)
    const { calls } = mockAgent({
      'POST http://agent.test/v1/users/*/dialogs': () =>
        json({
          dialogId: 'd-7',
          resumed: true,
          greeting: 'Продолжим?',
          sinceLastDialogHours: 48,
          messageCount: 5,
          lastActivityAt: '2026-10-01T20:12:00.000Z',
        }),
    })

    const started = ok<StartDialogApiResponse>(
      await call(app, 'POST', '/api/dialogs', { mode: DialogMode.Vent }, tokens.accessToken, {
        'X-Platform': 'android',
        'X-App-Version': '12',
      }),
    )
    expect(started).toEqual({
      dialogId: 'd-7',
      resumed: true,
      greeting: 'Продолжим?',
      sinceLastDialogHours: 48,
      messageCount: 5,
      lastActivityAt: '2026-10-01T20:12:00.000Z',
    })

    const agentCall = calls.at(-1)!
    expect(agentCall.url.pathname).toBe(`/v1/users/${user.id}/dialogs`)
    expect(JSON.parse(agentCall.body)).toEqual({ voice: 'male' })
  })

  it('агент не прислал messageCount и lastActivityAt — в ответе 0 и null, клиент ничего не спрашивает', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    mockAgent({
      'POST http://agent.test/v1/users/*/dialogs': () => json({ dialogId: 'd-5', resumed: true }),
    })

    const started = ok<StartDialogApiResponse>(await call(app, 'POST', '/api/dialogs', {}, tokens.accessToken))

    expect(started).toEqual({
      dialogId: 'd-5',
      resumed: true,
      greeting: null,
      sinceLastDialogHours: null,
      messageCount: 0,
      lastActivityAt: null,
    })
  })

  it('startNew: true уходит агенту как new: true; без него старт ничего не завершает', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)
    const { calls, dialogs } = mockAgent()

    const first = ok<StartDialogApiResponse>(await call(app, 'POST', '/api/dialogs', {}, tokens.accessToken))
    expect(first).toMatchObject({ dialogId: 'd-1', resumed: false, messageCount: 0 })
    dialogs.say(user.id, 3)

    // The plain start finds the dialog the person left and hands it back with what the client needs to ask.
    const again = ok<StartDialogApiResponse>(await call(app, 'POST', '/api/dialogs', {}, tokens.accessToken))
    expect(again).toMatchObject({ dialogId: 'd-1', resumed: true, messageCount: 3 })
    expect(typeof again.lastActivityAt).toBe('string')
    expect(dialogs.ended).toEqual([])
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ voice: 'male' })

    // The person answered "end it and begin a new one".
    const fresh = ok<StartDialogApiResponse>(
      await call(app, 'POST', '/api/dialogs', { startNew: true }, tokens.accessToken),
    )
    expect(fresh).toMatchObject({ dialogId: 'd-2', resumed: false, messageCount: 0, lastActivityAt: null })
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ voice: 'male', new: true })
    expect(dialogs.ended).toEqual(['d-1'])
    expect(dialogs.openOf(user.id)).toBe('d-2')
  })

  it('startNew не булево — 400, агента не трогаем', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    const { calls } = mockAgent()

    const response = await call(app, 'POST', '/api/dialogs', { startNew: 'yes' }, tokens.accessToken)

    expect(response.status).toBe(400)
    expect(calls).toEqual([])
  })

  it('выбранный в профиле голос уходит агенту при каждом старте и ответом не отдаётся', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    const { calls } = mockAgent({
      'POST http://agent.test/v1/users/*/dialogs': () =>
        json({ dialogId: 'd-9', resumed: false, voice: 'female' }),
    })

    ok(await call(app, 'PATCH', '/api/auth/me', { voice: 'female' }, tokens.accessToken))
    const started = ok<StartDialogApiResponse>(
      await call(app, 'POST', '/api/dialogs', {}, tokens.accessToken),
    )
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ voice: 'female' })
    // The voice is the profile's business: the dialog answer keeps its shape.
    expect(started).toEqual({
      dialogId: 'd-9',
      resumed: false,
      greeting: null,
      sinceLastDialogHours: null,
      messageCount: 0,
      lastActivityAt: null,
    })

    ok(await call(app, 'PATCH', '/api/auth/me', { voice: 'male' }, tokens.accessToken))
    ok(await call(app, 'POST', '/api/dialogs', {}, tokens.accessToken))
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ voice: 'male' })
  })

  it('старый клиент шлёт режим, новый нет — оба получают диалог', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    mockAgent({
      'POST http://agent.test/v1/users/*/dialogs': () => json({ dialogId: 'd-8', resumed: false }),
    })

    for (const body of [{ mode: DialogMode.Vent }, {}]) {
      const started = ok<StartDialogApiResponse>(
        await call(app, 'POST', '/api/dialogs', body, tokens.accessToken),
      )
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

    const listed = ok<ListDialogsApiResponse>(
      await call(app, 'GET', '/api/dialogs', undefined, tokens.accessToken),
    )
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
    const response = await app.request('/api/dialogs/d-x', {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    })
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

  it('старт по access-токену завершённой сессии — 401 и агента не трогает: подпись ещё верна, сессии нет', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)
    const phone = ok<{ tokens: { accessToken: string } }>(
      await call(app, 'POST', '/api/auth/login', { email: user.email, password: PASSWORD }),
    ).tokens
    ok(await call(app, 'POST', '/api/auth/logout-all', { keepCurrent: true }, tokens.accessToken))
    const { calls } = mockAgent()

    const started = await call(app, 'POST', '/api/dialogs', {}, phone.accessToken)

    expect(started.status).toBe(401)
    expect(calls).toEqual([])
    // The session that was kept still starts a dialog.
    mockAgent({
      'POST http://agent.test/v1/users/*/dialogs': () => json({ dialogId: 'd-kept', resumed: false }),
    })
    ok(await call(app, 'POST', '/api/dialogs', {}, tokens.accessToken))
  })
})

// ─── WebSocket gateway ────────────────────────────────────────────────────────

interface AgentConnection {
  socket: WebSocket
  /** Headers of the handshake the gateway made. */
  headers: IncomingHttpHeaders
  received: unknown[]
  binaryFrames: Buffer[]
}

interface FakeAgent {
  url: string
  /** Connection by dialog id: each test has its own, so tests do not interfere with each other. */
  waitFor: (dialogId: string) => Promise<AgentConnection>
  /** Whether the gateway has opened a connection for this dialog. */
  opened: (dialogId: string) => boolean
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
      headers: request.headers,
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
    opened: (dialogId) => connections.has(dialogId),
    close: () =>
      new Promise<void>((resolve) => {
        // terminate rather than close: otherwise wss.close waits for clients and the hook times out.
        for (const connection of connections.values()) connection.socket.terminate()
        wss.close(() => server.close(() => resolve()))
      }),
  }
}

/** An open dialog asks about its session every second here, not every 30: the tests would wait that long. */
const sessionCheckEnv = { DIALOG_SESSION_CHECK_SEC: '1' }

/** The app with WebSocket: as in production, the upgrade is intercepted before Hono. */
async function startGatewayServer(agentUrl: string) {
  // The agent address reaches the gateway through the app env rather than the core's getEnv():
  // otherwise clearing the stubs in setup.ts between tests would point the socket at the real address.
  const gatewayEnv = { AGENT_API_URL: agentUrl, ...sessionCheckEnv }
  const env = parseEnv({ ...process.env, ...gatewayEnv })
  const { app: hono, resetLimits: resetGatewayLimits } = makeApp({ env: gatewayEnv })
  const jwt = createJwt(env.MOBILE_JWT_SECRET)
  const sessions = createSessions(jwt)
  // What the gateway reports to PostHog is read back by the tests below.
  const analytics = recordingAnalytics()

  const server = serve({ fetch: hono.fetch, port: 0, createServer }) as unknown as Server
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    if ((request.url ?? '').split('?')[0] !== ApiPath.DialogsWs) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) =>
      handleDialogSocket(ws as never, { env, jwt, sessions, analytics }, request),
    )
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 50))
  const { port } = server.address() as AddressInfo
  return {
    wsUrl: `ws://127.0.0.1:${port}${ApiPath.DialogsWs}`,
    jwt,
    sessions,
    analytics,
    /** A real account with a registered session: the gateway asks the registry, so a token minted by hand would be refused. */
    async signIn() {
      resetGatewayLimits()
      const { user, tokens } = await signUpAndIn(hono, undefined, { consents: false })
      return { userId: user.id, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }
    },
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
    const { accessToken } = await gateway.signIn()
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
        expect.arrayContaining([
          expect.objectContaining({ type: 'user_message', id: 'c-1', text: 'тяжело' }),
        ]),
      ),
    )

    agentSide.socket.send(JSON.stringify({ type: 'ack', id: 'c-1', messageId: 'm-1' }))
    expect(await nextFrame(client, DialogServerFrame.Ack)).toMatchObject({
      clientId: 'c-1',
      messageId: 'm-1',
    })

    client.close()
  })

  it('заголовки трассировки из рукопожатия клиента уходят агенту, а userId подменяется проверенным', async () => {
    const { userId, accessToken } = await gateway.signIn()
    const client = new WebSocket(gateway.wsUrl, {
      headers: {
        'x-trace-id': 'trace-ws-1',
        'x-request-time': '2026-10-04T10:00:00.000Z',
        'x-client-id': 'ryadom-test',
        'x-session-id': 'session-ws-1',
        'x-user-id': 'forged-user',
      },
    })
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-trace-1' }))

    const agentSide = await agent.waitFor('d-trace-1')
    expect(agentSide.headers).toMatchObject({
      'x-trace-id': 'trace-ws-1',
      'x-request-time': '2026-10-04T10:00:00.000Z',
      'x-client-id': 'ryadom-test',
      'x-session-id': 'session-ws-1',
      'x-user-id': userId,
    })
    client.close()
  })

  it('сокет без заголовков (браузер их задать не может): агенту уходят все пять пустыми', async () => {
    const { userId, accessToken } = await gateway.signIn()
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-trace-2' }))

    const agentSide = await agent.waitFor('d-trace-2')
    // No trace id is made up, but the account is known from the token.
    expect(agentSide.headers['x-trace-id']).toBe('')
    expect(agentSide.headers['x-request-time']).toBe('')
    expect(agentSide.headers['x-client-id']).toBe('')
    expect(agentSide.headers['x-session-id']).toBe('')
    expect(agentSide.headers['x-user-id']).toBe(userId)
    client.close()
  })

  it('кадр safety без линий помощи дополняется нашими', async () => {
    const { accessToken } = await gateway.signIn()
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

  it('аналитика: завершённый диалог — счётчики реплик, длительность и перемена напряжения, но не текст', async () => {
    const { userId, accessToken } = await gateway.signIn()
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-an-1' }))
    const agentSide = await agent.waitFor('d-an-1')

    client.send(JSON.stringify({ type: DialogClientFrame.Message, clientId: 'c-1', text: 'секретная реплика' }))
    await vi.waitFor(() => expect(agentSide.received).toContainEqual(expect.objectContaining({ type: 'user_message' })))
    // One spoken turn: only the final transcript counts, the partial one does not. The agent also
    // sends a final one with no text for silence or an echo, and stores no message for it.
    agentSide.socket.send(JSON.stringify({ type: 'transcript', text: 'ну', final: false }))
    agentSide.socket.send(JSON.stringify({ type: 'transcript', text: 'ну вот', final: true, messageId: 'm-9' }))
    agentSide.socket.send(JSON.stringify({ type: 'transcript', text: '', final: true }))
    agentSide.socket.send(JSON.stringify({ type: 'transcript', text: '   ', final: true }))
    agentSide.socket.send(JSON.stringify({ type: 'assistant_end', messageId: 'm-2', text: 'секретный ответ' }))
    client.send(JSON.stringify({ type: DialogClientFrame.End, takeaway: 'секретный вывод', tensionAfter: 3 }))
    await vi.waitFor(() => expect(agentSide.received).toContainEqual(expect.objectContaining({ type: 'end' })))
    agentSide.socket.send(
      JSON.stringify({
        type: 'ended',
        summary: { title: 'секретный заголовок', themes: [], tensionBefore: 7, tensionAfter: 3 },
      }),
    )
    await nextFrame(client, DialogServerFrame.Ended)
    await new Promise<void>((resolve) => client.once('close', () => resolve()))

    const mine = gateway.analytics.events.filter((entry) => entry.userId === userId)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({
      event: 'dialog_ended',
      properties: {
        via: 'socket',
        user_messages: 2,
        assistant_messages: 1,
        has_takeaway: true,
        tension_delta: -4,
        tension_improved: true,
      },
    })
    expect(typeof mine[0]!.properties.duration_s).toBe('number')
    expect(JSON.stringify(mine)).not.toMatch(/секретн/)
  })

  it('аналитика: клиент оборвал связь после реплики — dialog_interrupted, и ровно один раз', async () => {
    const { userId, accessToken } = await gateway.signIn()
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-an-2' }))
    const agentSide = await agent.waitFor('d-an-2')
    client.send(JSON.stringify({ type: DialogClientFrame.Message, clientId: 'c-1', text: 'привет' }))
    await vi.waitFor(() => expect(agentSide.received).toContainEqual(expect.objectContaining({ type: 'user_message' })))

    client.close()
    await vi.waitFor(() =>
      expect(gateway.analytics.events.filter((entry) => entry.userId === userId)).toHaveLength(1),
    )
    // Give a possible duplicate (socket close after dispose) time to show itself.
    await new Promise<void>((resolve) => setTimeout(resolve, 150))
    const mine = gateway.analytics.events.filter((entry) => entry.userId === userId)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({
      event: 'dialog_interrupted',
      properties: { reason: 'client_closed', user_messages: 1 },
    })
  })

  it('аналитика: подключение без единой реплики ничего не сообщает (переподключения — не новость)', async () => {
    const { userId, accessToken } = await gateway.signIn()
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-an-3' }))
    await agent.waitFor('d-an-3')
    client.close()
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    expect(gateway.analytics.events.filter((entry) => entry.userId === userId)).toEqual([])
  })

  it('аналитика: кризисный сигнал считается без человека', async () => {
    const before = gateway.analytics.events.length
    const { accessToken } = await gateway.signIn()
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-an-4' }))
    const agentSide = await agent.waitFor('d-an-4')

    agentSide.socket.send(JSON.stringify({ type: 'safety', level: 'crisis', text: 'я рядом' }))
    await nextFrame(client, DialogServerFrame.Safety)

    const signals = gateway.analytics.events.slice(before).filter((entry) => entry.event === 'safety_signal')
    expect(signals).toEqual([{ userId: null, event: 'safety_signal', properties: { level: 'crisis' } }])
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
    const { accessToken } = await gateway.signIn()
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
    const { accessToken } = await gateway.signIn()
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
    const { accessToken } = await gateway.signIn()
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
    for (const index of [0, 1, 2]) {
      const { accessToken } = await gateway.signIn()
      const client = new WebSocket(gateway.wsUrl)
      await waitOpen(client)
      client.send(
        JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: `d-roll-${index}` }),
      )
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
    expect(codes).toEqual([
      DialogCloseCode.Restarting,
      DialogCloseCode.Restarting,
      DialogCloseCode.Restarting,
    ])
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
    const { accessToken } = await gateway.signIn()
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
    const { accessToken } = await gateway.signIn()
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

  describe('сессия, которую завершили', () => {
    /** Opens a dialog and waits until the agent side sees it, so the socket is past `hello`. */
    async function openDialog(accessToken: string, dialogId: string) {
      const client = new WebSocket(gateway.wsUrl)
      await waitOpen(client)
      client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId }))
      await agent.waitFor(dialogId)
      return client
    }
    const closedWith = (client: WebSocket) => new Promise<number>((resolve) => client.once('close', resolve))

    it('открытый диалог закрывается кодом Unauthorized после отзыва сессии', async () => {
      const { userId, accessToken } = await gateway.signIn()
      const client = await openDialog(accessToken, 'd-revoked-1')
      const closed = closedWith(client)

      await gateway.sessions.endAll(userId, null)

      expect(await closed).toBe(DialogCloseCode.Unauthorized)
    })

    it('закрывается и после выхода (logout) этой сессии, а чужая сессия того же человека не страдает', async () => {
      const { userId, accessToken, refreshToken } = await gateway.signIn()
      const client = await openDialog(accessToken, 'd-signed-out')
      const closed = closedWith(client)
      const payload = await gateway.jwt.verifyToken(refreshToken, 'refresh')
      await gateway.sessions.end(payload!.jti!)
      expect(await closed).toBe(DialogCloseCode.Unauthorized)

      // Another session of the same person is not touched by the first one's sign-out.
      const other = await gateway.sessions.start(userId, { clientId: null, userAgent: null })
      const second = await openDialog(other.accessToken, 'd-other-session')
      await new Promise((resolve) => setTimeout(resolve, 2500))
      expect(second.readyState).toBe(WebSocket.OPEN)
      second.close()
    })

    it('живой диалог не трогают: проверки проходят, соединение остаётся', async () => {
      const { accessToken } = await gateway.signIn()
      const client = await openDialog(accessToken, 'd-alive')

      // Two intervals of the check have passed by now.
      await new Promise((resolve) => setTimeout(resolve, 2500))

      expect(client.readyState).toBe(WebSocket.OPEN)
      client.close()
    })

    it('hello с access-токеном завершённой сессии отвергается: подпись ещё верна, а сессии нет', async () => {
      const { userId, accessToken } = await gateway.signIn()
      await gateway.sessions.endAll(userId, null)
      const client = new WebSocket(gateway.wsUrl)
      await waitOpen(client)

      client.send(
        JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-late-hello' }),
      )

      const error = await nextFrame(client, DialogServerFrame.Error)
      expect(error.code).toBe(DialogWsErrorCode.UNAUTHORIZED)
      expect(await closedWith(client)).toBe(DialogCloseCode.Unauthorized)
      // The agent was never opened for it.
      expect(agent.opened('d-late-hello')).toBe(false)
    })

    it('токен, которого нет в реестре, отвергается: без записи о сессии доверять нечему', async () => {
      const { accessToken } = await gateway.jwt.issueTokenPair('99999999-9999-4999-8999-999999999999')
      const client = new WebSocket(gateway.wsUrl)
      await waitOpen(client)

      client.send(
        JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-unknown-session' }),
      )

      expect((await nextFrame(client, DialogServerFrame.Error)).code).toBe(DialogWsErrorCode.UNAUTHORIZED)
    })
  })
})
