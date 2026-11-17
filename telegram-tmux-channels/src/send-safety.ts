// Когда отправку в Telegram можно повторить, не рискуя дублем, и как слать её молча.
//
// При 5xx и обрыве сети Telegram часто уже опубликовал сообщение, просто ответ до нас не дошёл.
// Повтор такого запроса — второе сообщение в чате. Поэтому публикующие методы повторяем только на 429,
// а при неизвестном исходе отдаём ошибку вызывающему.
import { GrammyError, type Bot } from 'grammy'

type Transformer = Parameters<Bot['api']['config']['use']>[0]

const PUBLISHING_METHOD = /^(send|forward|copy)/
const EPHEMERAL_METHODS: ReadonlySet<string> = new Set(['sendChatAction'])
const BAD_REQUEST = 400
const REACTION_METHOD = 'setMessageReaction'

/** Повтор метода после 5xx или обрыва сети может опубликовать сообщение второй раз. */
export function isRepeatUnsafe(method: string): boolean {
  return PUBLISHING_METHOD.test(method) && !EPHEMERAL_METHODS.has(method)
}

/** Telegram отверг сам запрос: сообщение точно не опубликовано, его можно слать в другой форме. */
export function isRejectedRequest(err: unknown): boolean {
  return err instanceof GrammyError && err.error_code === BAD_REQUEST
}

/**
 * Хаб без уведомлений: сообщения без звука, без ответа-цитаты и без реакций.
 * Ответ и реакция на сообщение человека звенят у него даже в заглушённой группе, звук тут ни при чём.
 */
export const silenceTransformer: Transformer = (prev, method, payload, signal) => {
  if (method === REACTION_METHOD) {
    return Promise.resolve({ ok: true, result: true } as never)
  }
  if (!isRepeatUnsafe(method)) {
    return prev(method, payload, signal)
  }
  const { reply_parameters: _reply, reply_to_message_id: _replyId, ...rest } = payload as Record<string, unknown>
  return prev(method, { ...rest, disable_notification: true } as typeof payload, signal)
}
