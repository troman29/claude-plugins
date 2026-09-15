import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parsePicker } from '../src/picker'
import { buildKeyboard, confirmAfterDigit, parseCallback } from '../src/picker-drive'

const fx = (n: string) => readFileSync(join(import.meta.dir, 'fixtures', n), 'utf8')

describe('buildKeyboard', () => {
  test('single: button per option, custom as its own button, no Submit', () => {
    const p = parsePicker(fx('ask-single.txt'))!
    const kb = buildKeyboard(p, 'ab12cd34', [])
    const flat = kb.buttons.flat()
    expect(flat.find(b => b.data === 'pk:ab12cd34:o1')?.text).toBe('Tea')
    expect(flat.some(b => b.data === 'pk:ab12cd34:c')).toBe(true)
    expect(flat.some(b => b.data === 'pk:ab12cd34:s')).toBe(false)
    expect(kb.text).toContain('Tea or coffee?')
  })
  test('multi: toggle labels from checked, has Submit', () => {
    const p = parsePicker(fx('ask-multi.txt'))!
    const kb = buildKeyboard(p, 'dcab0000', [2])
    const flat = kb.buttons.flat()
    expect(flat.find(b => b.data === 'pk:dcab0000:o1')?.text).toBe('Python')
    expect(flat.find(b => b.data === 'pk:dcab0000:o2')?.text).toBe('✅ Go')
    expect(flat.some(b => b.data === 'pk:dcab0000:s')).toBe(true)
  })
})

describe('parseCallback', () => {
  test('opt/submit/custom; foreign data → undefined', () => {
    expect(parseCallback('pk:ab12cd34:o3')).toEqual({ token: 'ab12cd34', action: { kind: 'opt', index: 3 } })
    expect(parseCallback('pk:dcab0000:s')).toEqual({ token: 'dcab0000', action: { kind: 'submit' } })
    expect(parseCallback('pk:dcab0000:c')).toEqual({ token: 'dcab0000', action: { kind: 'custom' } })
    expect(parseCallback('perm:allow:abcde')).toBeUndefined()
  })
})

// Страж 15.09: в Codex цифра на первой стадии /model уже выбирает модель и открывает вторую
// (усилие), а Enter хаба через полсекунды подтверждал там вариант под курсором за человека.
describe('confirmAfterDigit', () => {
  const stage1 = parsePicker(fx('codex-0154-model-picker.txt'))!

  test('на экране открылась следующая стадия — Enter не жмём', () => {
    expect(confirmAfterDigit(parsePicker(fx('codex-0154-reasoning-stage.txt')), stage1.hash)).toBe(false)
  })

  test('тот же пикер (Claude: цифра сдвинула курсор) — Enter подтверждает', () => {
    expect(confirmAfterDigit(parsePicker(fx('codex-0154-model-picker.txt')), stage1.hash)).toBe(true)
  })

  test('пикер закрылся — Enter безвреден', () => {
    expect(confirmAfterDigit(undefined, stage1.hash)).toBe(true)
  })
})
