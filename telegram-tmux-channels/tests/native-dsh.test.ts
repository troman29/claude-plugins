import { describe, expect, test } from 'bun:test'
import { NativeDshHub, type DshClaim, type DshCommand } from '../src/native-dsh'

const claim: DshClaim = { key: '-100/42', runtime: 'host-a', profile: 'default', sessionId: 'session-a', capability: 'a'.repeat(64) }

function fixture() {
  let binding = { ...claim }
  const sent: { conn: number; message: { id: string; command: DshCommand } }[] = []
  const hub = new NativeDshHub<number>({ binding: () => binding,
    send: (conn, message) => { sent.push({ conn, message }) } })
  return { hub, sent, rotate: () => { binding = { ...binding, capability: 'b'.repeat(64) } } }
}

describe('native DSH authorization', () => {
  for (const field of ['runtime', 'profile', 'sessionId', 'capability'] as const) {
    test(`rejects a mismatched ${field}`, () => {
      const { hub } = fixture()
      expect(() => hub.subscribe(1, { ...claim, [field]: 'b'.repeat(64) })).toThrow('authorization')
    })
  }
  test('rejects a second owner', () => {
    const { hub } = fixture()
    hub.subscribe(1, claim)
    expect(() => hub.subscribe(2, claim)).toThrow('already connected')
  })
  test('revocation blocks existing connections', () => {
    const { hub, rotate } = fixture()
    hub.subscribe(1, claim)
    rotate()
    expect(hub.key(1)).toBeUndefined()
  })
  test('acknowledges only a result from the target connection', async () => {
    const { hub, sent } = fixture()
    hub.subscribe(1, claim)
    const result = hub.request(claim.key, { action: 'prompt', requestId: 'telegram:42', mode: 'queue', text: 'hello' })
    hub.result(2, { id: sent[0]!.message.id, ok: true, result: 'wrong' })
    hub.result(1, { id: sent[0]!.message.id, ok: true, result: 'accepted' })
    expect(await result).toBe('accepted')
  })
  test('an incomplete positive receipt does not claim admission', async () => {
    const { hub, sent } = fixture()
    hub.subscribe(1, claim)
    const result = hub.request(claim.key, { action: 'status' })
    hub.result(1, { id: sent[0]!.message.id, ok: true })
    await expect(result).rejects.toThrow('failed')
  })
  test('disconnection fails pending delivery without retry', async () => {
    const { hub, sent } = fixture()
    hub.subscribe(1, claim)
    const result = hub.request(claim.key, { action: 'status' })
    hub.disconnect(1)
    await expect(result).rejects.toThrow('unknown')
    expect(sent).toHaveLength(1)
  })
  test('never routes an unknown key by directory', async () => {
    const { hub, sent } = fixture()
    await expect(hub.request('-100/99', { action: 'resume' })).rejects.toThrow('unavailable')
    expect(sent).toHaveLength(0)
  })
})
