// Когда отправку в Telegram можно повторить, не рискуя дублем.
//
// При 5xx и обрыве сети Telegram часто уже опубликовал сообщение, просто ответ до нас не дошёл.
// Повтор такого запроса — второе сообщение в чате. Поэтому публикующие методы повторяем только на 429,
// а при неизвестном исходе отдаём ошибку вызывающему.
import { GrammyError } from 'grammy'

const PUBLISHING_METHOD = /^(send|forward|copy)/
const EPHEMERAL_METHODS: ReadonlySet<string> = new Set(['sendChatAction'])
const BAD_REQUEST = 400

/** Повтор метода после 5xx или обрыва сети может опубликовать сообщение второй раз. */
export function isRepeatUnsafe(method: string): boolean {
  return PUBLISHING_METHOD.test(method) && !EPHEMERAL_METHODS.has(method)
}

/** Telegram отверг сам запрос: сообщение точно не опубликовано, его можно слать в другой форме. */
export function isRejectedRequest(err: unknown): boolean {
  return err instanceof GrammyError && err.error_code === BAD_REQUEST
}
