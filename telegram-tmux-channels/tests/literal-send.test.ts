import { describe, expect, test } from 'bun:test'
import { literalSendText } from '../src/literal-send'

describe('/send literal payload', () => {
  test('explicit body wins and preserves slash commands plus newlines', () => {
    expect(literalSendText(' /compact\nkeep this ', 'quoted')).toBe('/compact\nkeep this')
  })

  test('bare /send uses text or caption from the replied message', () => {
    expect(literalSendText(undefined, 'original message')).toBe('original message')
    expect(literalSendText(undefined, undefined, 'photo caption')).toBe('photo caption')
  })

  test('empty command without a usable reply has no payload', () => {
    expect(literalSendText(undefined, undefined, undefined)).toBeUndefined()
  })
})
