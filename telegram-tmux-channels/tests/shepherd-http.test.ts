import { writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, test } from 'bun:test'
import { createShepherd, type Shepherd } from '../src/shepherd/index'
import { tokenMatches } from '../src/shepherd/server'
import { event, request, tempDir, OWNER_KEY } from './shepherd-helpers'

const TOKEN = 'secret-token'
let running: Shepherd | undefined
afterEach(() => running?.stop())

function start(config: Record<string, unknown> = {}, tokenFile: string | null = TOKEN) {
  const stateDir = tempDir()
  writeFileSync(join(stateDir, 'shepherd.json'), JSON.stringify({
    repos: { 'windbit/agentek-console': 'on' }, http: { listen: '127.0.0.1:0' }, ...config,
  }))
  if (tokenFile) {
    writeFileSync(join(stateDir, 'shepherd.token'), tokenFile + '\n', { mode: 0o600 })
  }
  running = createShepherd({
    stateDir, bindings: () => ({ [OWNER_KEY]: { dir: '/w/one' } }),
    deliver: async () => 'ok', post: async () => {}, log: () => {}, reopenTopic: async () => {},
    spawn: { groups: () => ({}), createTopic: async () => ({ key: '-100/9' }), saveBinding: async () => {} },
    exec: async cmd => (cmd[3] === 'branch' ? { code: 0, stdout: 'feat/x' } : { code: 0, stdout: 'git@github.com:windbit/agentek-console.git' }),
  })
  running.start()
  return `http://127.0.0.1:${running.httpPort()}/shepherd/pr-event`
}

const post = (url: string, body: unknown, headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }) =>
  fetch(url, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })

describe('shepherd http intake', () => {
  test('no http section: no listener', () => {
    const stateDir = tempDir()
    writeFileSync(join(stateDir, 'shepherd.json'), JSON.stringify({ repos: {} }))
    running = createShepherd({
      stateDir, bindings: () => ({}), deliver: async () => 'ok', post: async () => {}, log: () => {}, reopenTopic: async () => {},
      spawn: { groups: () => ({}), createTopic: async () => ({ key: '' }), saveBinding: async () => {} },
    })
    running.start()
    expect(running.httpPort()).toBeUndefined()
  })

  test('valid request: same reply as the socket, owner included', async () => {
    const url = start()
    const response = await post(url, request('h1', event('comment')))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, status: 'persisted', owner: 'mine' })
    expect(await (await post(url, request('h1', event('comment')))).json()).toEqual({ ok: true, status: 'duplicate', owner: 'mine' })
  })

  test('pr-unowned over http', async () => {
    const url = start()
    expect(await (await post(url, { op: 'pr-unowned', v: 1, deliveryId: 'h1' })).json()).toEqual({ ok: true, status: 'accepted' })
  })

  test('401 without or with a wrong token, token from shepherd.json works without the file', async () => {
    const url = start()
    expect((await post(url, request('h1', event('comment')), {})).status).toBe(401)
    expect((await post(url, request('h1', event('comment')), { Authorization: 'Bearer nope' })).status).toBe(401)
    expect((await post(url, request('h1', event('comment')), { Authorization: TOKEN })).status).toBe(401)
    running!.stop()
    const inline = start({ token: 'inline' }, null)
    expect((await post(inline, request('h2', event('comment')), { Authorization: 'Bearer inline' })).status).toBe(200)
  })

  test('without any token every request is 401', async () => {
    const url = start({}, null)
    expect((await post(url, request('h1', event('comment')))).status).toBe(401)
  })

  test('only POST on the exact route', async () => {
    const url = start()
    expect((await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(405)
    expect((await post(url.replace('pr-event', 'other'), {})).status).toBe(404)
  })

  test('body over 256 KiB is refused, bad json and invalid events are 400', async () => {
    const url = start()
    expect([413, 400]).toContain((await post(url, 'x'.repeat(300 * 1024))).status)
    expect((await post(url, '{nope')).status).toBe(400)
    const invalid = await post(url, request('h1', event('pr_opened', { extra: 1 })))
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ ok: false, error: expect.stringContaining('invalid') })
  })

  test('a repo that is off answers disabled with 200', async () => {
    const url = start()
    const response = await post(url, request('h1', event('comment', { repo: 'windbit/other' })))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: false, error: 'disabled' })
  })
})

describe('tokenMatches', () => {
  test('exact bearer only', () => {
    expect(tokenMatches('Bearer a', 'a')).toBe(true)
    expect(tokenMatches('Bearer a', 'b')).toBe(false)
    expect(tokenMatches('Bearer ab', 'a')).toBe(false)
    expect(tokenMatches(null, 'a')).toBe(false)
    expect(tokenMatches('Bearer a', undefined)).toBe(false)
  })
})
