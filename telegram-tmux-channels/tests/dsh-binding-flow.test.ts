import { describe, expect, test } from 'bun:test'
import { DshRuntimes, type DshRuntimeMessage } from '../src/dsh-runtimes'
import { DshBindingFlow } from '../src/dsh-binding-flow'
import type { BindingEntry } from '../src/registry'

function fixture() {
  let registry: Record<string, BindingEntry> = {}
  let created = 0
  const sent: DshRuntimeMessage[] = []
  const runtimes = new DshRuntimes<number>({
    bindings: () => Object.entries(registry).flatMap(([key, entry]) => entry.dsh ? [{ key, ...entry.dsh }] : []),
    send: (conn, message) => {
      sent.push(message)
      if (message.op !== 'dsh-runtime-command') {
        return
      }
      const result = message.command.action === 'list'
        ? JSON.stringify([{ sessionId: 'existing', cwd: '/project', title: 'Previous work' }])
        : JSON.stringify({ sessionId: message.command.sessionId })
      if (message.command.action === 'create') {
        created++
      }
      queueMicrotask(() => runtimes.result(conn, { id: message.id, ok: true, result }))
    },
  })
  const flow = new DshBindingFlow({ runtimes, load: () => structuredClone(registry), save: value => { registry = value } })
  const register = () => runtimes.register(1, { runtime: 'web-runtime', profile: 'web', label: 'DSH Web' })
  return { flow, runtimes, register, sent, registry: () => registry, created: () => created }
}

describe('hub-owned DSH binding', () => {
  test('creates a session and persists its generated authority without operator files', async () => {
    const f = fixture()
    f.register()
    const menu = await f.flow.menu('-100/42', '/project')
    const binding = await f.flow.select(menu.token, 0)
    expect(f.registry()['-100/42']?.dsh).toEqual({ runtime: 'web-runtime', profile: 'web',
      sessionId: binding.sessionId, capability: binding.capability })
    expect(binding.capability).toMatch(/^[a-f0-9]{64}$/)
    expect(f.sent.at(-1)).toEqual({ op: 'dsh-bindings', bindings: [binding] })
    await expect(f.flow.select(menu.token, 0)).rejects.toThrow('expired')
    expect(f.created()).toBe(1)
  })

  test('selects an existing conversation and restores it after runtime reconnection', async () => {
    const f = fixture()
    f.register()
    const menu = await f.flow.menu('-100/42', '/project')
    const binding = await f.flow.select(menu.token, 1)
    expect(binding.sessionId).toBe('existing')
    expect(f.created()).toBe(0)
    f.runtimes.disconnect(1)
    f.register()
    expect(f.sent.at(-1)).toEqual({ op: 'dsh-bindings', bindings: [binding] })
    const otherMenu = await f.flow.menu('-100/99', '/project')
    expect(otherMenu.labels).toHaveLength(1)
  })

  test('rejects a stale menu when another topic acquires the same session', async () => {
    const f = fixture()
    f.register()
    const first = await f.flow.menu('-100/42', '/project')
    const second = await f.flow.menu('-100/99', '/project')
    await f.flow.select(first.token, 1)
    await expect(f.flow.select(second.token, 1)).rejects.toThrow('another topic')
    expect(f.registry()['-100/99']).toBeUndefined()
  })

  test('does not overwrite an existing CLI binding', async () => {
    const f = fixture()
    f.register()
    f.registry()['-100/42'] = { dir: '/project', agent: 'codex', sessionId: 'codex-session' }
    const menu = await f.flow.menu('-100/42', '/project')
    await expect(f.flow.select(menu.token, 1)).rejects.toThrow('Unbind')
    expect(f.registry()['-100/42']?.sessionId).toBe('codex-session')
  })

  test('disconnect rejects pending creation without replay or registry changes', async () => {
    const sent: DshRuntimeMessage[] = []
    const runtimes = new DshRuntimes<number>({ bindings: () => [], send: (_conn, message) => { sent.push(message) } })
    runtimes.register(1, { runtime: 'web', profile: 'web', label: 'Web' })
    const operation = runtimes.request('web', { action: 'create', cwd: '/project', sessionId: 'requested' })
    runtimes.result(2, { id: sent.at(-1)!.op === 'dsh-runtime-command' ? (sent.at(-1) as { id: string }).id : '', ok: true, result: '{}' })
    runtimes.disconnect(1)
    await expect(operation).rejects.toThrow('unknown')
    expect(sent.filter(message => message.op === 'dsh-runtime-command')).toHaveLength(1)
  })
})
