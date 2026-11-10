import { appendFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, test } from 'bun:test'
import { parseRequest, semanticKey } from '../src/shepherd/protocol'
import { ShepherdStore } from '../src/shepherd/store'
import { event, request, tempDir, SHA } from './shepherd-helpers'

describe('shepherd protocol', () => {
  test('every kind of the contract is accepted', () => {
    for (const kind of ['pr_opened', 'pr_reopened', 'pr_ready', 'pr_synchronize', 'pr_closed', 'checks_completed', 'review', 'review_comment', 'comment'] as const) {
      expect(parseRequest(request('d1', event(kind))).ok).toBe(true)
    }
  })

  test('deliveryId with a PR suffix and optional fields omitted are fine', () => {
    const noLine = event('review_comment') as Record<string, unknown>
    delete noLine.line
    expect(parseRequest(request('abc-123#1687', noLine as never)).ok).toBe(true)
    expect(parseRequest(request('d', event('pr_closed', { merged: false, mergedBy: undefined }))).ok).toBe(true)
  })

  test('rejects unknown kind, unknown fields, bad types and long strings', () => {
    const bad = [
      request('d', { ...event('pr_opened'), kind: 'push' } as never),
      request('d', event('pr_opened', { extra: 1 })),
      request('d', event('pr_opened', { headSha: 'xyz' })),
      request('d', event('pr_opened', { pr: '12' })),
      request('d', event('pr_opened', { prTitle: 'x'.repeat(501) })),
      request('d', event('review', { state: 'dismissed' })),
      request('d', event('comment', { association: 'STRANGER' })),
      request('d', event('comment', { url: 'javascript:alert(1)' })),
      { ...request('d', event('pr_opened')), extra: true },
      { ...request('d', event('pr_opened')), v: 2 },
      { ...request('d', event('pr_opened')), op: 'restart' },
      { ...request('', event('pr_opened')) },
      'junk',
    ]
    for (const raw of bad) {
      const parsed = parseRequest(raw)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) {
        expect(parsed.error.startsWith('invalid:')).toBe(true)
      }
    }
  })

  test('semantic keys identify the same fact under different deliveries', () => {
    expect(semanticKey(event('checks_completed'))).toBe(semanticKey(event('checks_completed', { suiteId: 2 })))
    expect(semanticKey(event('checks_completed'))).not.toBe(semanticKey(event('checks_completed', { headSha: 'b'.repeat(40) })))
    expect(semanticKey(event('pr_synchronize'))).toBeUndefined()
  })
})

describe('shepherd store', () => {
  test('persisted events survive a crash and replay until a final state', () => {
    const dir = tempDir()
    const first = new ShepherdStore(dir)
    const a = first.persist('d1', event('comment', { id: 1 }))
    const b = first.persist('d2', event('comment', { id: 2 }))
    expect(a.status).toBe('persisted')
    if (a.status === 'persisted') {
      first.setState(a.item.id, 'delivered')
    }
    // «крэш»: старый объект брошен, новый читает только то, что лежит на диске
    const second = new ShepherdStore(dir)
    const open = second.undelivered()
    expect(open.map(item => item.deliveryId)).toEqual(['d2'])
    expect(b.status === 'persisted' && open[0]!.id === b.item.id).toBe(true)
  })

  test('a torn last line from a crash is skipped', () => {
    const dir = tempDir()
    const store = new ShepherdStore(dir)
    store.persist('d1', event('comment', { id: 1 }))
    appendFileSync(join(dir, 'inbox.jsonl'), '{"id":"broken","deliv')
    expect(new ShepherdStore(dir).undelivered().map(item => item.deliveryId)).toEqual(['d1'])
  })

  test('dedup by deliveryId and by semantic key, also after restart', () => {
    const dir = tempDir()
    const store = new ShepherdStore(dir)
    expect(store.persist('d1', event('comment', { id: 5 })).status).toBe('persisted')
    expect(store.persist('d1', event('pr_opened')).status).toBe('duplicate')
    expect(store.persist('d2', event('comment', { id: 5 })).status).toBe('duplicate')
    expect(store.persist('d3', event('pr_synchronize')).status).toBe('persisted')
    expect(store.persist('d4', event('pr_synchronize')).status).toBe('persisted')
    expect(new ShepherdStore(dir).persist('d9', event('comment', { id: 5 })).status).toBe('duplicate')
  })

  test('owners are written atomically and read back with their version', () => {
    const dir = tempDir()
    const store = new ShepherdStore(dir)
    store.setOwner('o/r#1', { key: '-1/2', version: 3, source: 'manual', at: 'now' })
    expect(new ShepherdStore(dir).getOwner('o/r#1')).toEqual({ key: '-1/2', version: 3, source: 'manual', at: 'now' })
    expect(JSON.parse(readFileSync(join(dir, 'owners.json'), 'utf8'))['o/r#1'].version).toBe(3)
  })

  test('CI failures count consecutive distinct shas; green resets', () => {
    const store = new ShepherdStore(tempDir())
    expect(store.recordCi('o/r#1', SHA, true)).toBe(1)
    expect(store.recordCi('o/r#1', SHA, true)).toBe(1)
    expect(store.recordCi('o/r#1', 'b'.repeat(40), true)).toBe(2)
    expect(store.recordCi('o/r#1', 'c'.repeat(40), false)).toBe(0)
    expect(store.recordCi('o/r#1', 'd'.repeat(40), true)).toBe(1)
  })

  test('retention drops old finished items but keeps open ones', () => {
    const dir = tempDir()
    let now = Date.parse('2026-11-01T00:00:00Z')
    const old = new ShepherdStore(dir, () => now)
    const done = old.persist('d1', event('comment', { id: 1 }))
    old.persist('d2', event('comment', { id: 2 }))
    if (done.status === 'persisted') {
      old.setState(done.item.id, 'delivered')
    }
    now = Date.parse('2026-11-20T00:00:00Z')
    const fresh = new ShepherdStore(dir, () => now)
    expect(fresh.persist('d1', event('comment', { id: 1 })).status).toBe('persisted')
    expect(fresh.undelivered().map(item => item.deliveryId).sort()).toEqual(['d1', 'd2'])
  })
})
