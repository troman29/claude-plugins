import { describe, expect, test } from 'bun:test'
import { GrammyError, HttpError } from 'grammy'
import { isRejectedRequest, isRepeatUnsafe, silenceTransformer } from '../src/send-safety'

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

describe('silenceTransformer', () => {
  function capture() {
    const calls: { method: string; payload: Record<string, unknown> }[] = []
    const prev = (async (method: string, payload: Record<string, unknown>) => {
      calls.push({ method, payload })
      return { ok: true, result: true }
    }) as never
    const call = (method: string, payload: Record<string, unknown>) => silenceTransformer(prev, method as never, payload as never)
    return { calls, call }
  }

  test('a message goes without sound and without quoting the human message', async () => {
    const { calls, call } = capture()
    await call('sendMessage', { chat_id: 1, text: 'hi', reply_parameters: { message_id: 5 }, message_thread_id: 7 })
    expect(calls[0]!.payload).toEqual({ chat_id: 1, text: 'hi', message_thread_id: 7, disable_notification: true })
  })

  test('a reaction is not sent at all', async () => {
    const { calls, call } = capture()
    expect(await call('setMessageReaction', { chat_id: 1, message_id: 5 })).toMatchObject({ ok: true })
    expect(calls).toEqual([])
  })

  test('edits pass through unchanged', async () => {
    const { calls, call } = capture()
    await call('editMessageText', { chat_id: 1, message_id: 5, text: 'x' })
    expect(calls[0]!.payload).toEqual({ chat_id: 1, message_id: 5, text: 'x' })
  })
})
