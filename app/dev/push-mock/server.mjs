#!/usr/bin/env node
/**
 * A stand-in for the RuStore Push API (`POST /v1/projects/{project}/messages:send`) for the end-to-end stand: the
 * server under test sends here (`RUSTORE_PUSH_API_URL`) and the tests read back what reached "the phone".
 *
 * It answers like the real one for what the server cares about: `200 {}` for a message taken, `404 NOT_FOUND` for a
 * token it no longer knows. Which is which is decided by the token, so a test chooses the answer by the token it
 * subscribes with:
 *
 * - `gone-…`: 404, the token is no longer the device's;
 * - `broken-…`: 500, the push service is down;
 * - anything else: 200.
 *
 * Dev endpoints: `GET /dev/messages` lists what was taken (`?token=` narrows it), `DELETE /dev/messages` forgets it.
 * No dependencies: plain `node server.mjs`, the port from PORT.
 */
import { createServer } from 'node:http'

const port = Number(process.env.PORT ?? 8091)
/** Everything a send carried, in arrival order, the refused ones included. */
let received = []

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

const SEND_PATH = /^\/v1\/projects\/([^/]+)\/messages:send$/

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)

  if (request.method === 'GET' && url.pathname === '/health') return send(response, 200, { status: 'ok' })

  if (url.pathname === '/dev/messages') {
    if (request.method === 'DELETE') {
      received = []
      return send(response, 200, {})
    }
    if (request.method === 'GET') {
      const token = url.searchParams.get('token')
      return send(response, 200, {
        messages: token ? received.filter((m) => m.message?.token === token) : received,
      })
    }
  }

  const match = request.method === 'POST' ? SEND_PATH.exec(url.pathname) : null
  if (!match)
    return send(response, 404, { error: { code: 404, status: 'NOT_FOUND', message: 'No such route' } })

  const authorization = request.headers.authorization ?? ''
  if (!/^Bearer \S+$/.test(authorization)) {
    return send(response, 401, {
      error: { code: 401, status: 'UNAUTHENTICATED', message: 'No service token' },
    })
  }
  let body
  try {
    body = JSON.parse(await readBody(request))
  } catch {
    return send(response, 400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Not JSON' } })
  }
  const message = body?.message
  if (typeof message?.token !== 'string' || (!message.notification && !message.data)) {
    return send(response, 400, {
      error: { code: 400, status: 'INVALID_ARGUMENT', message: 'No token or content' },
    })
  }
  const projectId = decodeURIComponent(match[1])
  const token = message.token
  const status = token.startsWith('gone-') ? 404 : token.startsWith('broken-') ? 500 : 200
  received.push({ projectId, authorization, message, status, at: new Date().toISOString() })
  if (status === 404) {
    return send(response, 404, {
      error: { code: 404, status: 'NOT_FOUND', message: 'Requested entity was not found.' },
    })
  }
  if (status === 500)
    return send(response, 500, { error: { code: 500, status: 'INTERNAL', message: 'Down' } })
  return send(response, 200, {})
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`push mock on http://127.0.0.1:${port}\n`)
})
