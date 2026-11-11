import { describe, expect, test } from 'bun:test'
import { harness, event, OWNER_KEY, SERVICE } from './shepherd-helpers'

const MIN = 60_000
const PR = 'windbit/agentek-console#1687'
const SPAWNED_KEY = '-100/77'

describe('owner answer', () => {
  test('a single branch candidate is registered and answers mine, a duplicate answers the same', async () => {
    const h = harness()
    expect(await h.send('d1', event('comment', { id: 1 }))).toEqual({ ok: true, status: 'persisted', owner: 'mine' })
    expect(h.store.getOwner(PR)).toMatchObject({ key: OWNER_KEY, source: 'branch' })
    expect(await h.send('d1', event('comment', { id: 1 }))).toEqual({ ok: true, status: 'duplicate', owner: 'mine' })
  })

  test('an existing record with a live binding answers mine; a closed binding without a branch match answers none', async () => {
    const h = harness()
    h.state.git['/w/one']!.branch = 'other'
    h.router.setOwner('windbit/agentek-console', 1687, OWNER_KEY)
    expect(await h.send('d1', event('comment', { id: 1 }))).toMatchObject({ owner: 'mine' })
    h.state.bindings[OWNER_KEY]!.closed = true
    expect(await h.send('d2', event('comment', { id: 2 }))).toMatchObject({ owner: 'none' })
  })

  test('nobody on the branch answers none, a duplicate too', async () => {
    const h = harness()
    h.state.git['/w/one']!.branch = 'other'
    expect(await h.send('d1', event('comment'))).toEqual({ ok: true, status: 'persisted', owner: 'none' })
    expect(await h.send('d1', event('comment'))).toEqual({ ok: true, status: 'duplicate', owner: 'none' })
  })
})

describe('non-primary hub', () => {
  test('foreign PR: not-mine, nothing posted, no spawn, no CI watch', async () => {
    const h = harness()
    h.state.config.primary = false
    h.state.git['/w/one']!.branch = 'other'
    await h.send('d1', event('comment'))
    await h.send('d2', event('checks_completed'))
    await h.send('d3', event('pr_closed'))
    await h.clock.advance(5 * MIN)
    expect(h.posts).toEqual([])
    expect(h.delivered).toEqual([])
    expect(h.state.spawnCalls).toEqual([])
    expect(h.state.ghCalls).toBe(0)
    expect(h.store.undelivered()).toEqual([])
  })

  test('own PR is delivered as usual', async () => {
    const h = harness()
    h.state.config.primary = false
    await h.send('d1', event('comment'))
    await h.clock.advance(MIN)
    expect(h.delivered.map(entry => entry.key)).toEqual([OWNER_KEY])
  })
})

describe('awaiting fan-out', () => {
  const unowned = () => {
    const h = harness()
    h.state.git['/w/one']!.branch = 'other'
    return h
  }

  test('without pr-unowned nothing is posted; pr-unowned runs the policy', async () => {
    const h = unowned()
    await h.send('d1', event('comment'))
    expect(h.posts).toEqual([])
    expect(h.store.stateOf(h.store.undelivered()[0]!.id)).toBe('awaiting-fanout')
    expect(await h.unowned('d1')).toEqual({ ok: true, status: 'accepted' })
    expect(h.state.spawnCalls).toEqual([PR])
    expect(h.posts).toHaveLength(1)
  })

  test('pr-unowned that arrived before the event is remembered', async () => {
    const h = unowned()
    await h.unowned('d1')
    await h.send('d1', event('comment'))
    expect(h.state.spawnCalls).toEqual([PR])
  })

  test('2 minutes without pr-unowned: the policy runs anyway', async () => {
    const h = unowned()
    await h.send('d1', event('comment'))
    await h.clock.advance(2 * MIN - 1000)
    expect(h.state.spawnCalls).toEqual([])
    await h.clock.advance(2000)
    expect(h.state.spawnCalls).toEqual([PR])
  })

  test('with fanout on, silence means somebody else owns it', async () => {
    const h = unowned()
    h.state.config.fanout = true
    await h.send('d1', event('comment'))
    await h.clock.advance(3 * MIN)
    expect(h.state.spawnCalls).toEqual([])
    expect(h.posts).toEqual([])
    expect(h.store.undelivered()).toEqual([])
  })

  test('a malformed pr-unowned is rejected', async () => {
    const h = unowned()
    expect(await h.router.accept({ op: 'pr-unowned', v: 1 })).toMatchObject({ ok: false })
  })
})

describe('no-owner policy', () => {
  const unowned = () => {
    const h = harness()
    h.state.git['/w/one']!.branch = 'other'
    return h
  }

  test('closed binding with an owner record: reopen the topic, same key, deliver', async () => {
    const h = unowned()
    h.router.setOwner('windbit/agentek-console', 1687, OWNER_KEY)
    h.state.bindings[OWNER_KEY]!.closed = true
    await h.send('d1', event('comment'))
    await h.unowned('d1')
    await h.clock.advance(MIN)
    expect(h.state.reopened).toEqual([OWNER_KEY])
    expect(h.delivered.map(entry => entry.key)).toEqual([OWNER_KEY])
    expect(h.state.spawnCalls).toEqual([])
  })

  test('reopen failure goes to the service topic', async () => {
    const h = unowned()
    h.router.setOwner('windbit/agentek-console', 1687, OWNER_KEY)
    h.state.bindings[OWNER_KEY]!.closed = true
    h.state.reopenFails = true
    await h.send('d1', event('comment'))
    await h.unowned('d1')
    expect(h.delivered).toEqual([])
    expect(h.posts[0]).toMatchObject({ target: SERVICE })
  })

  test('spawn: owner source spawn, immediate delivery with the intro and the event', async () => {
    const h = unowned()
    h.state.spawnResult = { kind: 'spawned', key: SPAWNED_KEY }
    h.state.bindings[SPAWNED_KEY] = { dir: '/w/two' }
    await h.send('d1', event('comment'))
    await h.unowned('d1')
    expect(h.store.getOwner(PR)).toMatchObject({ key: SPAWNED_KEY, source: 'spawn' })
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]!.key).toBe(SPAWNED_KEY)
    expect(h.delivered[0]!.text.startsWith('Ты ведёшь PR https://github.com/windbit/agentek-console/pull/1687 (ветка feat/x). Пришло событие:\n\n🔔 PR')).toBe(true)
  })

  test('PR closed without an owner is only logged, no spawn', async () => {
    const h = unowned()
    await h.send('d1', event('pr_closed'))
    await h.unowned('d1')
    expect(h.state.spawnCalls).toEqual([])
    expect(h.posts).toEqual([])
    expect(h.store.undelivered()).toEqual([])
  })

  test('PR of a human author is not spawned', async () => {
    const h = unowned()
    await h.send('d1', event('comment', { prAuthor: 'troman29' }))
    await h.unowned('d1')
    expect(h.state.spawnCalls).toEqual([])
    expect(h.posts[0]!.text).toContain('не от агента')
  })

  test('branch busy: attach to the binding that sits in that worktree', async () => {
    const h = unowned()
    h.state.spawnResult = { kind: 'busy', dir: '/w/one' }
    h.state.bindings[OWNER_KEY]!.closed = true
    await h.send('d1', event('comment'))
    await h.unowned('d1')
    await h.clock.advance(MIN)
    expect(h.state.reopened).toEqual([OWNER_KEY])
    expect(h.delivered.map(entry => entry.key)).toEqual([OWNER_KEY])
    expect(h.store.getOwner(PR)).toMatchObject({ key: OWNER_KEY, source: 'branch' })
  })

  test('branch busy without a binding: service line', async () => {
    const h = unowned()
    h.state.spawnResult = { kind: 'busy', dir: '/elsewhere' }
    await h.send('d1', event('comment'))
    await h.unowned('d1')
    expect(h.delivered).toEqual([])
    expect(h.posts).toHaveLength(1)
  })

  test('no mapping: service line asks for shepherd.json spawn', async () => {
    const h = unowned()
    await h.send('d1', event('comment'))
    await h.unowned('d1')
    expect(h.posts[0]!.text).toContain('"windbit/agentek-console"')
    expect(h.posts[0]!.text).toContain('spawn')
  })

  test('limit: one service line per PR, the PR is retried and spawned later', async () => {
    const h = unowned()
    h.state.spawnResult = { kind: 'limit' }
    await h.send('d1', event('comment', { id: 1 }))
    await h.unowned('d1')
    await h.send('d2', event('comment', { id: 2 }))
    await h.unowned('d2')
    expect(h.posts).toHaveLength(1)
    expect(h.store.stateOf(h.store.undelivered()[0]!.id)).toBe('queued')
    h.state.spawnResult = { kind: 'spawned', key: SPAWNED_KEY }
    h.state.bindings[SPAWNED_KEY] = { dir: '/w/two' }
    await h.clock.advance(5 * MIN)
    await h.clock.advance(MIN)
    expect(h.delivered.map(entry => entry.key)).toEqual([SPAWNED_KEY, SPAWNED_KEY])
    expect(h.state.spawnCalls).toHaveLength(3) // 2 отказа по лимиту + 1 успех; второе событие нашло владельца
    expect(h.store.undelivered()).toEqual([])
  })
})
