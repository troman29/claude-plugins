import { describe, expect, test } from 'bun:test'
import { escapeForRich, needsRich } from '../src/md-html'

describe('needsRich', () => {
  test('a table needs it — both alignment styles and a ragged one', () => {
    expect(needsRich('| a | b |\n|---|---|\n| 1 | 2 |')).toBe(true)
    expect(needsRich('| a | b |\n|:--|--:|\n| 1 | 2 |')).toBe(true)
    expect(needsRich('текст\n\n| Что | Было |\n|:----|-----:|\n| x | 1 |\n\nещё')).toBe(true)
  })

  test('so do the other things HTML cannot express', () => {
    expect(needsRich('<details><summary>t</summary>x</details>')).toBe(true)
    expect(needsRich('ссылка[^1]\n\n[^1]: сноска')).toBe(true)
    expect(needsRich('$$E = mc^2$$')).toBe(true)
    expect(needsRich('это ==важно==')).toBe(true)
    expect(needsRich('это ||секрет||')).toBe(true)
  })

  test('anything HTML approximates well enough stays on the plain path', () => {
    expect(needsRich('просто ответ')).toBe(false)
    expect(needsRich('# Заголовок\n\n- пункт\n- ещё\n\n1. раз\n2. два')).toBe(false)
    expect(needsRich('**жирный**, `код`, [ссылка](https://t.me), > цитата')).toBe(false)
    expect(needsRich('```js\nconst a = 1\n```')).toBe(false)
  })

  test('pipes that are not a table do not trigger it', () => {
    expect(needsRich('ps aux | grep claude | wc -l')).toBe(false)
    expect(needsRich('a | b\nc | d')).toBe(false) // no separator row
  })

  test('operators written outside a code fence are not markup', () => {
    expect(needsRich('if (a || b || c) return')).toBe(false)
    expect(needsRich('проверь x == y == z')).toBe(false)
  })

  test('a table drawn inside a code fence is just code', () => {
    expect(needsRich('```\n| a | b |\n|---|---|\n```')).toBe(false)
  })
})

// Expectations here were verified against the live sendRichMessage API, not guessed:
// an unsupported tag comes back dropped from result.rich_message, and "#5" comes back a heading.
describe('escapeForRich', () => {
  test('an unsupported tag is escaped instead of being silently swallowed', () => {
    expect(escapeForRich('падает на <Foo attr=1>')).toBe('падает на &lt;Foo attr=1>')
    expect(escapeForRich('if (a < b && c > d)')).toBe('if (a &lt; b && c > d)')
  })

  test('tags Telegram does support are left to it', () => {
    expect(escapeForRich('<b>жирный</b> и <tg-spoiler>спойлер</tg-spoiler>')).toBe(
      '<b>жирный</b> и <tg-spoiler>спойлер</tg-spoiler>',
    )
    expect(escapeForRich('<details open><summary>t</summary>x</details>')).toBe(
      '<details open><summary>t</summary>x</details>',
    )
  })

  test('code keeps its angle brackets — Telegram already treats it verbatim', () => {
    expect(escapeForRich('смотри `<Foo>` тут')).toBe('смотри `<Foo>` тут')
    expect(escapeForRich('```\n<Foo attr=1>\n```')).toBe('```\n<Foo attr=1>\n```')
  })

  test('a hash without a space is not a heading', () => {
    expect(escapeForRich('#5 в очереди')).toBe('\\#5 в очереди')
    expect(escapeForRich('# Настоящий заголовок')).toBe('# Настоящий заголовок')
    expect(escapeForRich('  ## Отступ ок')).toBe('  ## Отступ ок')
  })
})
