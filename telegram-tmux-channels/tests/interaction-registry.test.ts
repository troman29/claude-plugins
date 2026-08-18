import { describe, expect, test } from 'bun:test'
import { InteractionRegistry, interactionKey, type PersistedInteraction } from '../src/interaction-registry'

const status = (updatedAt = 100): PersistedInteraction => ({
  kind: 'status', key: 'chat/1', updatedAt,
  data: {
    chatId: 'chat', threadId: 1, msgId: 42, bindingDir: '/repo', turnEnded: false,
    state: { agents: [['a', { name: 'worker', done: false }]], tasks: [], todos: [], skills: [] },
  },
})

describe('InteractionRegistry restart contract', () => {
  test('rehydrates a valid typed record and preserves the original message id', () => {
    const saved: Record<string, unknown> = { [interactionKey('status', 'chat/1')]: status() }
    const registry = new InteractionRegistry(saved, () => {}, 200)
    expect(registry.get('status', 'chat/1')?.msgId).toBe(42)
    expect(registry.get('status', 'chat/1')?.state.agents[0]?.[1].name).toBe('worker')
  })

  test('drops malformed, expired, and unknown records instead of reviving unsafe callbacks', () => {
    const saved: Record<string, unknown> = {
      malformed: { kind: 'skill-menu', key: 'x', updatedAt: 100, data: { names: '../../secret' } },
      expired: { ...status(0), expiresAt: 50 },
      unknown: { kind: 'future-kind', key: 'x', updatedAt: 100, data: {} },
    }
    const registry = new InteractionRegistry(saved, () => {}, 200)
    expect(registry.entries()).toEqual([])
  })

  test('writes and deletes one namespaced record without touching siblings', () => {
    let snapshot: Record<string, PersistedInteraction> = {}
    const registry = new InteractionRegistry({}, next => { snapshot = next }, 200)
    registry.set(status())
    registry.set({
      kind: 'skill-menu', key: '7', updatedAt: 100, expiresAt: 500,
      data: { bindingKey: 'chat/1', dir: '/repo', names: ['review'] },
    })
    registry.delete('status', 'chat/1')
    expect(snapshot[interactionKey('status', 'chat/1')]).toBeUndefined()
    expect(snapshot[interactionKey('skill-menu', '7')]?.kind).toBe('skill-menu')
  })

  test('restores button, custom-answer, live-view, and background state by kind', () => {
    let snapshot: Record<string, PersistedInteraction> = {}
    const a = new InteractionRegistry({}, next => { snapshot = next }, 200)
    a.set({ kind: 'background', key: 'chat/1', updatedAt: 200, data: {
      chatId: 'chat', msgId: 8, bindingDir: '/repo', tasks: [{ command: 'make test' }],
    } })
    a.set({ kind: 'custom-answer', key: '%1', updatedAt: 200, expiresAt: 500, data: {
      chatId: 'chat', threadId: 1, bindingKey: 'chat/1', at: 200, multi: false,
    } })
    a.set({ kind: 'live-screen', key: '9', updatedAt: 200, expiresAt: 500, data: {
      chatId: 'chat', threadId: 1, msgId: 9, pane: '%1', bindingKey: 'chat/1',
      lastText: 'working', viewKind: 'text', refreshUntil: 400,
    } })
    const b = new InteractionRegistry(JSON.parse(JSON.stringify(snapshot)), () => {}, 300)
    expect(b.get('background', 'chat/1')?.msgId).toBe(8)
    expect(b.get('custom-answer', '%1')?.bindingKey).toBe('chat/1')
    expect(b.get('live-screen', '9')?.lastText).toBe('working')
  })

  test('binding teardown removes direct and nested ownership without touching neighbours', () => {
    const registry = new InteractionRegistry({}, () => {}, 200)
    registry.set(status())
    registry.set({ kind: 'skill-menu', key: '1', updatedAt: 200, data: {
      bindingKey: 'chat/1', dir: '/repo', names: ['review'],
    } })
    registry.set({ kind: 'skill-menu', key: '2', updatedAt: 200, data: {
      bindingKey: 'chat/2', dir: '/repo', names: ['review'],
    } })
    registry.deleteBinding('chat/1')
    expect(registry.get('status', 'chat/1')).toBeUndefined()
    expect(registry.get('skill-menu', '1')).toBeUndefined()
    expect(registry.get('skill-menu', '2')).toBeDefined()
  })
})
