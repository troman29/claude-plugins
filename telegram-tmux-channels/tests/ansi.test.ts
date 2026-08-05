import { describe, expect, test } from 'bun:test'
import { ansiSegments } from '../src/ansi'
import { ansiToImage } from '../src/ansi-image'

describe('ansi', () => {
  test('ansiSegments: цвет, инверсия, разбивка по строкам', () => {
    const lines = ansiSegments('\x1b[31mред\x1b[0m прост\n\x1b[7mинв\x1b[0m')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toEqual([{ text: 'ред', fg: '#f44747' }, { text: ' прост' }])
    expect(lines[1]).toEqual([{ text: 'инв', fg: '#1e1e1e', bg: '#d4d4d4' }]) // reverse разрешён в цвета
  })
  test('ansiSegments: не-SGR последовательности выкинуты', () => {
    expect(ansiSegments('\x1b[2Ja\x1b]0;title\x07b')).toEqual([[{ text: 'ab' }]])
  })
  test('ansiToImage: рисует JPEG без браузера', async () => {
    const jpg = await ansiToImage('\x1b[32mзелёный\x1b[0m ⎿ ✅ │└─\nвторая строка')
    expect([...jpg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]) // SOI + маркер
    expect(jpg.length).toBeGreaterThan(500)
  })
})
