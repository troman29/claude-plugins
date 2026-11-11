// shepherd.sock: NDJSON, одна строка запроса — одна строка ответа. Только `pr-event`.
import { createHash, timingSafeEqual } from 'crypto'
import { chmodSync } from 'fs'
import { rmQuiet, safeJsonParse } from '../util'
import type { Reply } from './router'

type Handler = (raw: unknown) => Promise<Reply>

const MAX_LINE_BYTES = 512 * 1024
const MAX_HTTP_BODY_BYTES = 256 * 1024
const HTTP_ROUTE = '/shepherd/pr-event'

export type HttpOptions = {
  host: string
  port: number
  /** Читается на каждый запрос: смена файла токена вступает без рестарта. */
  token: () => string | undefined
  handle: Handler
  log: (line: string) => void
}

function encode(reply: Reply): string {
  return JSON.stringify(reply) + '\n'
}

export function startShepherdServer(path: string, handle: Handler, log: (line: string) => void): () => void {
  rmQuiet(path)
  const buffers = new WeakMap<object, string>()
  const server = Bun.listen<undefined>({
    unix: path,
    socket: {
      open(sock) {
        buffers.set(sock, '')
      },
      async data(sock, data) {
        let buf = (buffers.get(sock) ?? '') + data.toString()
        if (buf.length > MAX_LINE_BYTES && !buf.includes('\n')) {
          sock.write(encode({ ok: false, error: 'invalid: line too long' }))
          sock.end()
          return
        }
        let end: number
        while ((end = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, end)
          buf = buf.slice(end + 1)
          if (line.trim()) {
            sock.write(encode(await respond(line)))
          }
        }
        buffers.set(sock, buf)
      },
      error(_sock, err) {
        log(`shepherd socket error: ${err}`)
      },
    },
  })
  chmodSync(path, 0o600)
  log(`shepherd listening on ${path}`)

  async function respond(line: string): Promise<Reply> {
    const raw = safeJsonParse<unknown>(line)
    if (raw === undefined) {
      return { ok: false, error: 'invalid: not json' }
    }
    try {
      return await handle(raw)
    } catch (e) {
      log(`shepherd request failed: ${e instanceof Error ? e.stack : e}`)
      return { ok: false, error: 'io: internal error' }
    }
  }

  return () => {
    server.stop(true)
    rmQuiet(path)
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

/** Сравнение за постоянное время: хэши одной длины, длина токена не утекает. */
export function tokenMatches(header: string | null, token: string | undefined): boolean {
  const given = /^Bearer (.+)$/.exec(header ?? '')?.[1]
  return !!token && given !== undefined && timingSafeEqual(digest(given), digest(token))
}

function statusOf(reply: Reply): number {
  if (reply.ok || reply.error === 'disabled') {
    return 200
  }
  return reply.error.startsWith('invalid') ? 400 : 500
}

/** Тот же `pr-event`, что и на сокете, по HTTP: слушаем только заданный хост. */
export function startShepherdHttp(options: HttpOptions): { port: number; stop: () => void } {
  const { host, port, token, handle, log } = options
  const server = Bun.serve({
    hostname: host,
    port,
    maxRequestBodySize: MAX_HTTP_BODY_BYTES,
    async fetch(request) {
      if (new URL(request.url).pathname !== HTTP_ROUTE) {
        return Response.json({ ok: false, error: 'not found' }, { status: 404 })
      }
      if (request.method !== 'POST') {
        return Response.json({ ok: false, error: 'method not allowed' }, { status: 405, headers: { Allow: 'POST' } })
      }
      if (!tokenMatches(request.headers.get('authorization'), token())) {
        return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
      }
      const body = await request.arrayBuffer()
      if (body.byteLength > MAX_HTTP_BODY_BYTES) {
        return Response.json({ ok: false, error: 'invalid: body too large' }, { status: 413 })
      }
      const raw = safeJsonParse<unknown>(new TextDecoder().decode(body))
      if (raw === undefined) {
        return Response.json({ ok: false, error: 'invalid: not json' }, { status: 400 })
      }
      try {
        const reply = await handle(raw)
        return Response.json(reply, { status: statusOf(reply) })
      } catch (e) {
        log(`shepherd http request failed: ${e instanceof Error ? e.stack : e}`)
        return Response.json({ ok: false, error: 'io: internal error' }, { status: 500 })
      }
    },
  })
  log(`shepherd http listening on ${host}:${server.port}`)
  return { port: server.port ?? port, stop: () => void server.stop(true) }
}
