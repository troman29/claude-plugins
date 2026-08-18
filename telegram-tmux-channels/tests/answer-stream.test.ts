import { describe, expect, test } from 'bun:test'
import { AnswerStream, type AnswerStreamRecord } from '../src/answer-stream'

function harness(saved?: AnswerStreamRecord) {
  const calls: string[] = []
  let record = saved
  const stream = new AnswerStream({
    load: () => record,
    save: value => { record = value },
    clear: () => { record = undefined },
    publishDraft: async value => { calls.push(`draft:${value.draftId}:${value.text}`) },
  })
  return { stream, calls, record: () => record }
}

describe('answer streaming contract', () => {
  test('cumulative snapshots reuse exactly one draft id', async () => {
    const h = harness()
    await h.stream.update({ key: 'chat/1', chatId: 'chat', threadId: 1, bindingDir: '/repo', turnAt: 10 }, 'Hel')
    await h.stream.update({ key: 'chat/1', chatId: 'chat', threadId: 1, bindingDir: '/repo', turnAt: 10 }, 'Hello')
    expect(new Set(h.calls.map(call => call.split(':')[1])).size).toBe(1)
    expect(h.calls.map(call => call.split(':').slice(2).join(':'))).toEqual(['Hel', 'Hello'])
  })

  test('final delivery waits behind the last draft update', async () => {
    const order: string[] = []
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const stream = new AnswerStream({ load: () => undefined, save: () => {}, clear: () => {},
      publishDraft: async () => { await blocked; order.push('draft') } })
    const updating = stream.update({ key: 'chat/1', chatId: 'chat', bindingDir: '/repo', turnAt: 10 }, 'answer')
    const finishing = stream.finalize('chat/1', async () => { order.push('final') })
    await Promise.resolve()
    expect(order).toEqual([])
    release()
    await Promise.all([updating, finishing])
    expect(order).toEqual(['draft', 'final'])
  })

  test('explicit final is sent once and closes the stream', async () => {
    const h = harness()
    await h.stream.update({ key: 'chat/1', chatId: 'chat', bindingDir: '/repo', turnAt: 10 }, 'answer')
    let finals = 0
    expect(await h.stream.finalize('chat/1', async () => { finals++ })).toBe(true)
    expect(await h.stream.finalize('chat/1', async () => { finals++ })).toBe(false)
    expect(finals).toBe(1)
    expect(h.record()).toBeUndefined()
    h.stream.begin('chat/1')
    await h.stream.update({ key: 'chat/1', chatId: 'chat', bindingDir: '/repo', turnAt: 20 }, 'next')
    expect(h.record()?.turnAt).toBe(20)
  })

  test('restart resumes the persisted draft id and rejects a recycled binding', async () => {
    const saved: AnswerStreamRecord = {
      key: 'chat/1', chatId: 'chat', threadId: 1, bindingDir: '/repo', turnAt: 10,
      draftId: 77, text: 'Hel', updatedAt: 11,
    }
    const resumed = harness(saved)
    await resumed.stream.update({ key: 'chat/1', chatId: 'chat', threadId: 1, bindingDir: '/repo', turnAt: 10 }, 'Hello')
    expect(resumed.calls).toEqual(['draft:77:Hello'])

    const recycled = harness(saved)
    await recycled.stream.update({ key: 'chat/1', chatId: 'chat', threadId: 1, bindingDir: '/other', turnAt: 20 }, 'new')
    expect(recycled.calls[0]?.startsWith('draft:77:')).toBe(false)
  })
})
