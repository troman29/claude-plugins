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
      { send: async () => 99, edit: async () => {} },
    )
    await post.update('topic', true, () => 'new turn')
    expect(dropped).toBe(1)
    expect(persisted).toEqual([['topic', 99, false]])
  })
})
