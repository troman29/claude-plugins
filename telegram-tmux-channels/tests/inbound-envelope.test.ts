// Конверт входящего для Codex. Страж 15.09: первая доставка печатала конверт без delivery_id,
// сторож искал в роллауте именно его, не находил и слал сообщение второй раз — 5–9 дублей на топик.
import { describe, expect, test } from 'bun:test'
import { codexSessionForIncoming, codexTranscriptSawIncoming } from '../src/agents/codex'
import { deliveryNeedle, inboundEnvelope } from '../src/inbound-envelope'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const META = { chat_id: '-100', message_id: '3828', topic_id: '3615' }

describe('inboundEnvelope', () => {
  test('конверт с delivery_id находится меткой сторожа', () => {
    const text = inboundEnvelope('привет', { ...META, delivery_id: 'd1-2-3' }, false)
    expect(text).toContain(deliveryNeedle('d1-2-3'))
  })

  test('кавычки в значениях не ломают метку', () => {
    const id = 'd"odd"'
    expect(inboundEnvelope('x', { delivery_id: id }, false)).toContain(deliveryNeedle(id))
  })

  test('подсказка про reply — только когда просили', () => {
    expect(inboundEnvelope('x', META, true)).toContain('`reply` tool')
    expect(inboundEnvelope('x', META, false)).not.toContain('`reply` tool')
  })

  test('без meta — голое тело', () => {
    expect(inboundEnvelope('просто текст', {}, true)).toBe('просто текст')
  })
})

describe('метка сторожа в настоящем роллауте Codex', () => {
  const dir = '/work/app'
  const at = Date.parse('2026-09-15T09:18:00Z')
  const userItem = (text: string, ts: string) => JSON.stringify({
    timestamp: ts, type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  })
  const withRollout = (lines: string[], run: () => void) => {
    const root = mkdtempSync(join(tmpdir(), 'codex-env-'))
    const state = mkdtempSync(join(tmpdir(), 'codex-env-state-'))
    process.env.CODEX_HOME = root
    process.env.TELEGRAM_STATE_DIR = state
    try {
      const day = join(root, 'sessions', '2026', '09', '15')
      mkdirSync(day, { recursive: true })
      const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'sess-1', cwd: dir, source: 'cli' } })
      writeFileSync(join(day, 'rollout-a.jsonl'), [meta, ...lines].join('\n') + '\n')
      run()
    } finally {
      delete process.env.CODEX_HOME
      delete process.env.TELEGRAM_STATE_DIR
      rmSync(root, { recursive: true, force: true })
      rmSync(state, { recursive: true, force: true })
    }
  }

  test('впечатанный конверт находится и привязывает сессию с первой доставки', () => {
    const typed = inboundEnvelope('Ну там с памятью?', { ...META, delivery_id: 'd42' }, true)
    withRollout([userItem(typed, '2026-09-15T09:18:04Z')], () => {
      expect(codexTranscriptSawIncoming(dir, at, deliveryNeedle('d42'))).toBe(true)
      expect(codexSessionForIncoming(dir, at, deliveryNeedle('d42'))).toBe('sess-1')
    })
  })

  test('конверт без метки сторож не засчитывает — так и рождался дубль', () => {
    const typed = inboundEnvelope('Ну там с памятью?', META, true)
    withRollout([userItem(typed, '2026-09-15T09:18:04Z')], () => {
      expect(codexTranscriptSawIncoming(dir, at, deliveryNeedle('d42'))).toBe(false)
    })
  })
})
