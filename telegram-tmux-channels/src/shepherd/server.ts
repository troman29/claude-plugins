// shepherd.sock: NDJSON, одна строка запроса — одна строка ответа. Только `pr-event`.
import { chmodSync } from 'fs'
import { rmQuiet, safeJsonParse } from '../util'
import type { Reply } from './router'

type Handler = (raw: unknown) => Promise<Reply>

const MAX_LINE_BYTES = 512 * 1024

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
