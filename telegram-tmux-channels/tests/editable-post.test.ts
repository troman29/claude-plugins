import { describe, expect, test } from 'bun:test'
import { EditablePost } from '../src/editable-post'

describe('EditablePost restart contract', () => {
  test('a recovered post edits its original Telegram message instead of duplicating it', async () => {
    const sent: string[] = []
    const edited: [string, number, string][] = []
    const post = new EditablePost(
      [['topic', { msgId: 42, turnEnded: false }]], () => {}, () => {},
      {
        send: async (_key, text) => { sent.push(text); return 99 },
        edit: async (key, id, text) => { edited.push([key, id, text]) },
        remove: async () => {},
      },
    )
    await post.update('topic', false, () => '4/4 complete')
    expect(sent).toEqual([])
    expect(edited).toEqual([['topic', 42, '4/4 complete']])
  })

  test('a fresh turn intentionally starts a new message and persists its id', async () => {
    const persisted: [string, number, boolean][] = []
    let dropped = 0
    const post = new EditablePost(
      [['topic', { msgId: 42, turnEnded: true }]], (...args) => persisted.push(args), () => { dropped++ },
      { send: async () => 99, edit: async () => {}, remove: async () => {} },
    )
    await post.update('topic', true, () => 'new turn')
    expect(dropped).toBe(1)
    expect(persisted).toEqual([['topic', 99, false]])
  })

  // Стоп фонового агента приходит уже после конца хода; сбрось он границу — старты следующего
  // хода снова правили бы старый пузырь, уехавший вверх топика.
  test('refresh правит пост, но оставляет ход закрытым', async () => {
    const edited: number[] = []
    const post = new EditablePost(
      [['topic', { msgId: 42, turnEnded: true }]], () => {}, () => {},
      { send: async () => 99, edit: async (_key, id) => { edited.push(id) }, remove: async () => {} },
    )
    await post.refresh('topic', () => 'agent done')
    expect(edited).toEqual([42])
    expect(post.sinceTurnEnd('topic')).toBe(true)
    await post.refresh('other', () => 'nothing sent yet')
    expect(edited).toEqual([42])
  })

  // Живые агенты переезжают в новый пузырь; старый, оставшись с ними, висел бы дублем с вечными 🟡.
  test('retire правит или удаляет старый пост до того, как update(fresh) откроет новый', async () => {
    const calls: string[] = []
    const post = new EditablePost(
      [['a', { msgId: 42, turnEnded: true }], ['b', { msgId: 43, turnEnded: true }]], () => {}, () => {},
      {
        send: async () => 99,
        edit: async (_key, id, text) => { calls.push(`edit ${id} ${text}`) },
        remove: async (_key, id) => { calls.push(`remove ${id}`) },
      },
    )
    await post.retire('a', '✅ готов')
    await post.retire('b', undefined)
    await post.update('b', true, () => '🟡 фоновый')
    await post.retire('none', undefined)
    expect(calls).toEqual(['edit 42 ✅ готов', 'remove 43'])
  })
})
