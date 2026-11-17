import { describe, expect, test } from 'bun:test'
import { GrammyError, HttpError } from 'grammy'
import { isRejectedRequest, isRepeatUnsafe } from '../src/send-safety'

function grammyError(code: number): GrammyError {
  return new GrammyError('call failed', { ok: false, error_code: code, description: 'x' }, 'sendMessage', {})
}

describe('isRepeatUnsafe', () => {
  test('publishing methods are unsafe to repeat', () => {
    for (const method of ['sendMessage', 'sendRichMessage', 'sendDocument', 'sendMediaGroup', 'forwardMessage', 'copyMessage']) {
      expect(isRepeatUnsafe(method)).toBe(true)
    }
  })

  test('typing, edits and reads are safe to repeat', () => {
    for (const method of ['sendChatAction', 'editMessageText', 'getUpdates', 'setMessageReaction', 'getFile']) {
      expect(isRepeatUnsafe(method)).toBe(false)
    }
  })
})

describe('isRejectedRequest', () => {
  test('400 means Telegram did not publish the message', () => {
    expect(isRejectedRequest(grammyError(400))).toBe(true)
  })

  test('5xx and network errors leave the outcome unknown', () => {
    expect(isRejectedRequest(grammyError(504))).toBe(false)
    expect(isRejectedRequest(new HttpError('Network request failed', new Error('ECONNRESET')))).toBe(false)
  })
})
