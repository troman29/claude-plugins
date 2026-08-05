import { describe, expect, test } from 'bun:test'
import { ansiSegments } from '../src/ansi'
import { ansiToPng } from '../src/ansi-png'

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
  test('ansiToPng: рисует PNG без браузера', () => {
    const png = ansiToPng('\x1b[32mзелёный\x1b[0m ⎿ ✅ │└─\nвторая строка')
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(png.length).toBeGreaterThan(500)
  })
})
