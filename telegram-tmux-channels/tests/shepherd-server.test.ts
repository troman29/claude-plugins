import { statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, test } from 'bun:test'
import { ackToOutcome, createShepherd, parsePrUrl, watchdogApplies, parseShepherdCommand, type Shepherd } from '../src/shepherd/index'
import { event, request, tempDir, OWNER_KEY } from './shepherd-helpers'

let running: Shepherd | undefined
afterEach(() => running?.stop())

async function ask(path: string, lines: string[]): Promise<unknown[]> {
  const replies: string[] = []
  let buf = ''
  let done!: () => void
  const finished = new Promise<void>(resolve => (done = resolve))
  const socket = await Bun.connect({
    unix: path,
    socket: {
      data(_sock, data) {
        buf += data.toString()
        const parts = buf.split('\n')
        buf = parts.pop()!
        replies.push(...parts)
        if (replies.length >= lines.length) {
          done()
        }
      },
    },
  })
  socket.write(lines.map(line => line + '\n').join(''))
  await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error('no reply')), 5000))])
  socket.end()
  return replies.map(line => JSON.parse(line))
}

describe('shepherd.sock', () => {
  test('round trip: persisted, duplicate, invalid, disabled; socket is 0600', async () => {
    const stateDir = tempDir()
    writeFileSync(join(stateDir, 'shepherd.json'), JSON.stringify({ repos: { 'windbit/agentek-console': 'on' } }))
    const delivered: string[] = []
    running = createShepherd({
      stateDir, bindings: () => ({ [OWNER_KEY]: { dir: '/w/one' } }),
      deliver: async (_key, text) => {
        delivered.push(text)
        return 'ok'
      },
      post: async () => {}, log: () => {},
      exec: async () => ({ code: 0, stdout: '' }),
    })
    running.start()
    expect(statSync(running.socketPath).mode & 0o777).toBe(0o600)
    const other = event('comment', { repo: 'windbit/other' })
    const replies = await ask(running.socketPath, [
      JSON.stringify(request('d1', event('comment'))),
      JSON.stringify(request('d1', event('comment'))),
      JSON.stringify(request('d2', event('pr_opened', { extra: 1 }))),
      JSON.stringify(request('d3', other)),
      '{not json',
      JSON.stringify({ op: 'restart', key: '1/2' }),
    ])
    expect(replies[0]).toEqual({ ok: true, status: 'persisted' })
    expect(replies[1]).toEqual({ ok: true, status: 'duplicate' })
    expect(replies[2]).toMatchObject({ ok: false, error: expect.stringContaining('invalid') })
    expect(replies[3]).toEqual({ ok: false, error: 'disabled' })
    expect(replies[4]).toMatchObject({ ok: false, error: 'invalid: not json' })
    expect(replies[5]).toMatchObject({ ok: false, error: expect.stringContaining('invalid') })
  })
})

describe('shepherd commands', () => {
  test('parseShepherdCommand and parsePrUrl', () => {
    expect(parseShepherdCommand('/own https://github.com/o/r/pull/5')).toEqual({ cmd: 'own', arg: 'https://github.com/o/r/pull/5' })
    expect(parseShepherdCommand('/own@bot')).toEqual({ cmd: 'own' })
    expect(parseShepherdCommand('/shepherd')).toEqual({ cmd: 'shepherd' })
    expect(parseShepherdCommand('/ownership')).toBeUndefined()
    expect(parsePrUrl('https://github.com/o/r/pull/5/files')).toEqual({ repo: 'o/r', pr: 5 })
    expect(parsePrUrl('https://example.com/o/r/pull/5')).toBeUndefined()
  })
})

describe('delivery outcome', () => {
  test('only a positive stub ack counts as delivered', () => {
    expect(ackToOutcome('ok')).toBe('ok')
    expect(ackToOutcome('failed')).toBe('failed')
    expect(ackToOutcome('silent')).toBe('failed')
  })

  test('the watchdog does not retry what the shepherd retries itself', () => {
    expect(watchdogApplies(true, true)).toBe(false)
    expect(watchdogApplies(false, true)).toBe(true)
    expect(watchdogApplies(true, false)).toBe(true)
  })
})
