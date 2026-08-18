import { describe, expect, test } from 'bun:test'
import { replyContext } from '../src/reply-context'

describe('Telegram reply context', () => {
  test('includes replied message identity, author and text', () => {
    expect(replyContext({ message_id: 7, from: { id: 42, username: 'roma' }, text: 'original' })).toEqual({
      messageId: 7, user: 'roma', text: 'original',
    })
  })

  test('uses media caption and labels captionless media', () => {
    expect(replyContext({ message_id: 8, caption: 'see this', photo: [{}] })?.text).toBe('see this')
    expect(replyContext({ message_id: 9, photo: [{}] })?.text).toBe('[photo]')
  })

  test('bounds quoted text so a reply cannot duplicate a huge message into context', () => {
    const text = replyContext({ message_id: 10, text: 'x'.repeat(5000) })?.text ?? ''
    expect(text.length).toBeLessThanOrEqual(1201)
    expect(text.endsWith('…')).toBe(true)
  })
})
