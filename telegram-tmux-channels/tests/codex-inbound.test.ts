// Входящее для Codex печатается в его TUI. Фикстуры — живые снимки Codex 0.154 со стенда.
// Страж 15.09: хаб считал, что посреди хода Codex ввод не принимает, минуту ждал «готовности»
// и складывал сообщение в очередь до конца хода — в топике 12406 «ты тут?» дошло через 47 минут.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { codexInboundReady, codexInboundState } from '../src/agents/codex'

const fx = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8')

describe('codexInboundReady', () => {
  test('посреди хода печатать можно — Codex сам придержит до вызова тула', () => {
    expect(codexInboundReady(fx('codex-0154-pending-while-working.txt'))).toBe(true)
  })

  test('поверх пикера нельзя — Enter выбрал бы вариант', () => {
    expect(codexInboundReady(fx('codex-0154-model-picker.txt'))).toBe(false)
    expect(codexInboundReady(fx('codex-update-prompt.txt'))).toBe(false)
  })

  test('свободное поле ввода — можно', () => {
    expect(codexInboundReady('› Ask Codex to do anything\n\n  gpt-6-astra default · ~/p\n' + '\n'.repeat(40))).toBe(true)
  })
})

describe('codexInboundState', () => {
  test('принятое посреди хода видно в строке ↳ по метке', () => {
    expect(codexInboundState(fx('codex-0154-pending-while-working.txt'), 'delivery_id="d1-2-3"')).toBe('pending')
  })

  test('неотправленный текст в поле ввода — draft', () => {
    expect(codexInboundState(fx('codex-0154-draft.txt'), 'delivery_id="d9-9-9"')).toBe('draft')
  })

  test('отправленная реплика в истории — не draft: поле ввода — нижняя строка с ›', () => {
    const pane = '› [Telegram message; delivery_id="d5"]\n  тело\n• ответ\n› Ask Codex to do anything\n'
    expect(codexInboundState(pane, 'delivery_id="d5"')).toBeUndefined()
  })

  test('чужая метка не засчитывается', () => {
    expect(codexInboundState(fx('codex-0154-pending-while-working.txt'), 'delivery_id="other"')).toBeUndefined()
  })
})
