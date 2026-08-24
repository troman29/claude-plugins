import { describe, expect, test } from 'bun:test'
import { ProgressPost } from '../src/progress-post'

function transport() {
  const sent: string[] = []
  const edited: string[] = []
  return {
    sent,
    edited,
    send: async (text: string) => { sent.push(text); return 42 },
    edit: async (_id: number, text: string) => { edited.push(text) },
  }
}

describe('ProgressPost', () => {
  test('шаги уходят одним сообщением, а не пачкой', async () => {
    const t = transport()
    const post = new ProgressPost(t)
    post.step('📁 ~/projects/x')
    post.step('🆕 новая сессия')
    await post.settled()
    expect(t.sent).toEqual(['📁 ~/projects/x\n🆕 новая сессия']) // подряд идущие шаги схлопнулись
    post.step('✅ поехали')
    await post.settled()
    expect(t.edited).toEqual(['📁 ~/projects/x\n🆕 новая сессия\n✅ поехали'])
  })

  test('первые строки можно задать сразу', async () => {
    const t = transport()
    const post = new ProgressPost(t, ['📁 папка'])
    await post.settled()
    expect(t.sent).toEqual(['📁 папка'])
    post.step('готово')
    await post.settled()
    expect(t.edited).toEqual(['📁 папка\nготово'])
  })

  test('упавшая отправка не теряет последующие шаги', async () => {
    const sent: string[] = []
    let first = true
    const post = new ProgressPost({
      send: async (text: string) => {
        sent.push(text)
        if (first) { first = false; throw new Error('429') }
        return 7
      },
      edit: async () => {},
    })
    post.step('первый')
    await post.settled()
    post.step('второй')
    await post.settled()
    expect(sent).toEqual(['первый', 'первый\nвторой']) // вторая отправка несёт ОБЕ строки
  })

  test('пустые строки не создают пустых правок', async () => {
    const t = transport()
    const post = new ProgressPost(t)
    post.step('раз')
    post.step('   ')
    await post.settled()
    expect(t.edited).toEqual([])
  })

  test('долгий шаг тикает секундами и застывает итогом', async () => {
    const t = transport()
    const post = new ProgressPost(t)
    post.running(seconds => `🌱 готовлю… ${seconds} с`, 50)
    await post.settled()
    expect(t.sent).toEqual(['🌱 готовлю… 0 с'])

    await new Promise(resolve => setTimeout(resolve, 1150)) // ждём реальную секунду: рендер в секундах
    await post.settled()
    expect(t.edited.at(-1)).toMatch(/^🌱 готовлю… [1-9]\d* с$/) // счётчик пошёл

    post.settle('🌱 готово за 9 с')
    post.step('🆕 сессия')
    await post.settled()
    expect(t.edited.at(-1)).toBe('🌱 готово за 9 с\n🆕 сессия')
  }, 5000)

  test('мгновенный долгий шаг не оставляет строки «0 с»', async () => {
    const t = transport()
    const post = new ProgressPost(t, ['⏳ поднимаю'])
    post.running(seconds => `🌱 готовлю… ${seconds} с`, 50)
    post.settle('') // уложился в секунду — строку убираем совсем
    post.step('🆕 сессия')
    await post.settled()
    // правки схлопнулись в одну отправку — важен итоговый текст, а не число вызовов
    expect(t.sent.at(-1)).toBe('⏳ поднимаю\n🆕 сессия')
  })
})
