import { describe, expect, test } from 'bun:test'
import { TUI_KEYS, TUI_NOOP_DATA, isTuiKey, tuiButtons, tuiKeyLabel } from '../src/tui-keys'

describe('кнопки /tui', () => {
  test('Ctrl-C одиночный: второй подряд у Claude Code означает выход из сессии', () => {
    expect(TUI_KEYS.ctrlc).toBe('C-c')
    expect(TUI_KEYS.esc).toBe('Escape')
  })

  test('сетка 3×3: стрелки на своих сторонах, как на крестовине', () => {
    const rows = tuiButtons('7', '✖️ Close')
    expect(rows.map(row => row.map(button => button.data))).toEqual([
      ['tuikey:7:esc', 'tuikey:7:up', 'tuikey:7:ctrlc'],
      ['tuikey:7:left', TUI_NOOP_DATA, 'tuikey:7:right'],
      [TUI_NOOP_DATA, 'tuikey:7:down', 'scrclose:7'],
    ])
  })

  test('пустая клетка не пустая строка — иначе Telegram отобьёт всю клавиатуру', () => {
    const blanks = tuiButtons('7', 'x').flat().filter(button => button.data === TUI_NOOP_DATA)
    expect(blanks.length).toBe(2)
    for (const blank of blanks) {
      expect(blank.text.trim()).not.toBe('')
    }
  })

  test('callback_data влезает в лимит Telegram в 64 байта с запасом', () => {
    const longest = tuiButtons('999999', 'x').flat().map(button => Buffer.byteLength(button.data))
    expect(Math.max(...longest)).toBeLessThan(64)
  })

  test('чужое имя клавиши не проходит — в пейн уходят только клавиши из набора', () => {
    expect(isTuiKey('esc')).toBe(true)
    expect(isTuiKey('Enter')).toBe(false)
    expect(isTuiKey('constructor')).toBe(false)
  })

  test('подпись для тоста совпадает с подписью на кнопке', () => {
    expect(tuiKeyLabel('up')).toBe('↑')
  })
})
