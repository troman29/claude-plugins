// Единственное место, где номер топика превращается в поле Telegram.
//
// Раньше эта тернарка была скопирована в 22 места, причём поле топика называлось то
// `thread_id`, то `threadId`, то `tid`. Забыть её в одном вызове — значит отправить ответ
// в General вместо своего топика, и заметно это только глазами пользователя.
// Здесь же живёт тип адресата: чат плюс необязательный топик.

export type ChatTarget = { chat_id: string | number; thread_id?: number }

/** Разворачивается в поле сообщения: `{ ...topic(id), parse_mode: 'HTML' }`. */
export function topic(id: number | null | undefined): { message_thread_id?: number } {
  return id != null ? { message_thread_id: id } : {}
}
