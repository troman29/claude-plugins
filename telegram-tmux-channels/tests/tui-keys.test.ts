import { describe, expect, test } from 'bun:test'
import { TUI_KEYS, isTuiKey, tuiButtons, tuiKeyLabel } from '../src/tui-keys'

describe('кнопки /tui', () => {
  test('Ctrl-C одиночный: второй подряд у Claude Code означает выход из сессии', () => {
    expect(TUI_KEYS.ctrlc).toBe('C-c')
    expect(TUI_KEYS.esc).toBe('Escape')
  })

  test('раскладка: стрелки рядом, под ними Esc, Ctrl-C и закрытие', () => {
    const rows = tuiButtons('7', '✖️ Close')
    expect(rows.map(row => row.map(button => button.data))).toEqual([
      ['tuikey:7:left', 'tuikey:7:up', 'tuikey:7:down', 'tuikey:7:right'],
      ['tuikey:7:esc', 'tuikey:7:ctrlc', 'scrclose:7'],
    ])
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
