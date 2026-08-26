// Класс бага: два источника (хук агента и скрейп пейна) вели СВОИ реестры и слали в топик
// по посту каждый — Claude компактился, и Рома видел два «Компакция готова» подряд.
// Здесь проверяется контракт «один сеанс — один пост» в обоих порядках прихода.
import { describe, expect, test } from 'bun:test'
import { CompactionPosts, type CompactionDeps, type CompactionPost } from '../src/compaction'

const KEY = 'chat/42'
const DIR = '/home/user/projects/x'
const TARGET = { chatId: '-100', threadId: 42 }

function deps(opts: { sendFails?: boolean } = {}) {
  const sent: string[] = []
  const edits: [number, string][] = []
  const persisted: CompactionPost[] = []
  const forgotten: string[] = []
  let nextId = 100
  const d: CompactionDeps = {
    send: async (_target, html) => { sent.push(html); return opts.sendFails ? undefined : ++nextId },
    edit: async (post, html) => { edits.push([post.msgId, html]) },
    render: {
      started: trigger => `start(${trigger})`,
      bar: (pct, elapsed) => `bar ${pct}%${elapsed ? ` ${elapsed}` : ''}`,
      done: () => 'done',
    },
    persist: post => { persisted.push({ ...post }) },
    forget: key => { forgotten.push(key) },
  }
  return { d, sent, edits, persisted, forgotten }
}

const start = (posts: CompactionPosts, trigger = 'auto') =>
  posts.started({ bindingKey: KEY, bindingDir: DIR, target: TARGET, trigger })
const progress = (posts: CompactionPosts, pct: number, elapsed?: string) =>
  posts.progress({ bindingKey: KEY, bindingDir: DIR, pane: '%1', target: TARGET, pct, ...(elapsed ? { elapsed } : {}) })

describe('пост компакции', () => {
  test('хук завёл пост, бар пейна дополняет ЕГО и финал один', async () => {
    const t = deps()
    const posts = new CompactionPosts(t.d)
    await start(posts)
    await progress(posts, 5, '1m')
    await progress(posts, 40)
    await posts.finished(KEY)
    expect(t.sent).toEqual(['start(auto)']) // второго поста нет
    expect(t.edits).toEqual([[101, 'bar 5% 1m'], [101, 'bar 40%'], [101, 'done']])
  })

  test('бар пейна успел раньше — хук свой пост не заводит', async () => {
    const t = deps()
    const posts = new CompactionPosts(t.d)
    await progress(posts, 3)
    await start(posts)
    await progress(posts, 9)
    expect(t.sent).toEqual(['bar 3%'])
    expect(t.edits).toEqual([[101, 'bar 9%']])
  })

  test('одинаковый процент не тратит правку', async () => {
    const t = deps()
    const posts = new CompactionPosts(t.d)
    await progress(posts, 7)
    await progress(posts, 7)
    expect(t.edits).toEqual([])
  })

  test('пропавший бар финализирует пост только со ВТОРОГО промаха', async () => {
    const t = deps()
    const posts = new CompactionPosts(t.d)
    await progress(posts, 50)
    await posts.missed(KEY) // кадр посреди перерисовки
    expect(t.edits).toEqual([])
    await progress(posts, 51) // бар вернулся — счётчик промахов сброшен
    await posts.missed(KEY)
    await posts.missed(KEY)
    expect(t.edits).toEqual([[101, 'bar 51%'], [101, 'done']])
    expect(t.forgotten).toEqual([KEY])
  })

  test('пост без бара (Codex) промахами пейна не финализируется — только хуком', async () => {
    const t = deps()
    const posts = new CompactionPosts(t.d)
    await start(posts, 'manual')
    for (let i = 0; i < 5; i++) {
      await posts.missed(KEY)
    }
    expect(t.edits).toEqual([])
    await posts.finished(KEY)
    expect(t.edits).toEqual([[101, 'done']])
  })

  test('пока пост летит, соседний тик второй не шлёт', async () => {
    const t = deps()
    const posts = new CompactionPosts(t.d)
    await Promise.all([progress(posts, 1), progress(posts, 2)])
    expect(t.sent.length).toBe(1)
  })

  test('не ушедший пост освобождает слот — следующий тик пробует снова', async () => {
    const failing = deps({ sendFails: true })
    const posts = new CompactionPosts(failing.d)
    await progress(posts, 1)
    expect(posts.get(KEY)).toBeUndefined()
    await progress(posts, 2)
    expect(failing.sent).toEqual(['bar 1%', 'bar 2%'])
  })

  test('пережитый рестарт: пост восстановлен, бар правит его, а не шлёт новый', async () => {
    const t = deps()
    const restored: CompactionPost = { ...TARGET, msgId: 777, bindingKey: KEY, bindingDir: DIR, pane: '%1', lastPct: 30, misses: 0 }
    const posts = new CompactionPosts(t.d, [restored])
    await progress(posts, 60)
    expect(t.sent).toEqual([])
    expect(t.edits).toEqual([[777, 'bar 60%']])
  })

  test('отвязка топика забывает пост молча', async () => {
    const t = deps()
    const posts = new CompactionPosts(t.d)
    await start(posts)
    posts.drop(KEY)
    await posts.finished(KEY)
    expect(t.edits).toEqual([]) // в удалённый топик не пишем
  })
})
