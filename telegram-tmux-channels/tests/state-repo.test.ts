import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { HubStateRepository } from '../src/state-repo'
import type { Picker } from '../src/picker'
import { InteractionRegistry } from '../src/interaction-registry'

const picker: Picker = { title: 'Pick one', options: [{ index: 0, label: 'A' }, { index: 1, label: 'B' }], hash: 'abc123', mode: 'single' }
const tmp = () => mkdtempSync(join(tmpdir(), 'hubstate-'))

// Очередь — единственная структура, чей смысл в переживании рестарта. С обычной отложенной
// записью сообщение, положенное перед подъёмом сессии, терялось, если хаб перезапускали внутри
// окна задержки (28.08, топик 8505: раскат совпал с подъёмом).
describe('очередь придержанных сообщений', () => {
  const inbound = (text: string) => ({ text, chatId: '-100', threadId: 7, senderId: '1', at: 1_787_000_000_000 })

  test('пишется на диск сразу, без ожидания flush', () => {
    const dir = tmp()
    const a = new HubStateRepository(() => {}, dir)
    a.setQueued('-100/7', [inbound('не потеряй меня')])

    // второй репозиторий читает файл — никакого flush между ними не было
    const b = new HubStateRepository(() => {}, dir)
    expect(Object.fromEntries(b.queuedEntries())['-100/7']?.[0]?.text).toBe('не потеряй меня')
  })

  test('удаление тоже уходит на диск сразу', () => {
    const dir = tmp()
    const a = new HubStateRepository(() => {}, dir)
    a.setQueued('-100/7', [inbound('доставлено')])
    a.delQueued('-100/7')
    expect(new HubStateRepository(() => {}, dir).queuedEntries()).toEqual([])
  })
})

describe('HubStateRepository picker persistence', () => {
  test('pickers survive a flush→reload round-trip', () => {
    const dir = tmp()
    const a = new HubStateRepository(() => {}, dir)
    a.setPicker('%3', { chatId: '42', threadId: 7, msgId: 555, hash: 'abc123', token: 'abc123', picker, key: 'g:1:2', at: 2000 })
    a.flush()

    // a second repo pointed at the same dir rehydrates from disk
    const b = new HubStateRepository(() => {}, dir)
    const pickers = Object.fromEntries(b.pickerEntries())
    expect(pickers['%3']?.msgId).toBe(555)
    expect(pickers['%3']?.picker.options.length).toBe(2)
    expect(pickers['%3']?.key).toBe('g:1:2')

    // deletion persists too
    b.delPicker('%3')
    b.flush()
    const c = new HubStateRepository(() => {}, dir)
    expect(c.pickerEntries()).toEqual([])
  })

  test('an old state file missing the pickers key loads without throwing', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'hub-state.json'), JSON.stringify({ version: 1, pendingAnswer: { k: { dir: '/x', at: 5 } }, lastFallback: {} }))
    const r = new HubStateRepository(() => {}, dir)
    expect(r.pendingEntries()).toEqual([['k', { dir: '/x', at: 5 }]]) // old data still there
    expect(r.pickerEntries()).toEqual([]) // missing bucket defaults to empty
  })

  test('pending mode and first queued message survive a restart', () => {
    const dir = tmp()
    const a = new HubStateRepository(() => {}, dir)
    a.setPendingMode('g/7', { cfg: { modes: ['folder'], dir: '/project' }, topicName: 'New work', chatId: '-100', threadId: 7, agent: 'codex' })
    a.setQueued('g/7', [{ text: 'first task', chatId: '-100', threadId: 7, senderId: '9', msgId: 11, at: 12 }])
    a.flush()
    const b = new HubStateRepository(() => {}, dir)
    expect(Object.fromEntries(b.pendingModeEntries())['g/7']?.topicName).toBe('New work')
    expect(Object.fromEntries(b.pendingModeEntries())['g/7']?.agent).toBe('codex')
    expect(Object.fromEntries(b.queuedEntries())['g/7']?.[0]?.text).toBe('first task')
  })

  test('fresh-launch capture baseline survives a restart and can be cleared', () => {
    const dir = tmp()
    const a = new HubStateRepository(() => {}, dir)
    a.setLaunchCapture('g/8', { beforeIds: ['old-a', 'old-b'], at: 42 })
    a.flush()
    const b = new HubStateRepository(() => {}, dir)
    expect(Object.fromEntries(b.launchCaptureEntries())['g/8']).toEqual({ beforeIds: ['old-a', 'old-b'], at: 42 })
    b.delLaunchCapture('g/8')
    b.flush()
    expect(new HubStateRepository(() => {}, dir).launchCaptureEntries()).toEqual([])
  })

  test('typed interaction snapshot survives repository flush and reload', () => {
    const dir = tmp()
    const a = new HubStateRepository(() => {}, dir)
    const interactions = new InteractionRegistry(a.interactionSnapshot(), value => a.replaceInteractions(value), 10)
    interactions.set({
      kind: 'skill-menu', key: '3', updatedAt: 10, expiresAt: 100,
      data: { bindingKey: 'g/7', dir: '/repo', names: ['review'] },
    })
    a.flush()

    const b = new HubStateRepository(() => {}, dir)
    const restored = new InteractionRegistry(b.interactionSnapshot(), () => {}, 20)
    expect(restored.get('skill-menu', '3')).toEqual({ bindingKey: 'g/7', dir: '/repo', names: ['review'] })
  })

  test('объявленная ошибка переживает рестарт — иначе поднявшийся хаб объявит её заново', () => {
    const dir = tmp()
    const a = new HubStateRepository(() => {}, dir)
    a.setError('%20', { err: 'Login expired · Please run /login', at: 1_787_426_814_555 })
    a.flush()

    const b = new HubStateRepository(() => {}, dir)
    expect(b.errorEntries()).toEqual([['%20', { err: 'Login expired · Please run /login', at: 1_787_426_814_555 }]])

    b.delError('%20')
    b.flush()
    expect(new HubStateRepository(() => {}, dir).errorEntries()).toEqual([])
  })
})
