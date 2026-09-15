// Полосы: задачи с одним ключом идут строго по очереди, с разными — параллельно.
// Апдейты Telegram бегут по полосам топиков: иначе долгая команда в одном топике морозит весь
// бот (`/delete` с хуком очистки шёл 70 с, и хаб всё это время не забирал апдейты ни из одного
// чата). Ввод в пейн бежит по полосам пейнов: сообщение и `/model`, впечатанные одновременно,
// перемешали клавиши, и цифры конверта выбрали модель за человека.
import { messageKey } from './bindings'

type LaneMessage = {
  chat: { id: number; type: string }
  message_thread_id?: number
  reply_to_message?: { message_id: number; message_thread_id?: number; forum_topic_created?: unknown }
}

type LaneUpdate = {
  message?: LaneMessage
  edited_message?: LaneMessage
  callback_query?: { message?: LaneMessage; from: { id: number } }
  my_chat_member?: { chat: { id: number; type: string } }
}

/** Полоса апдейта — тот же ключ, что у биндинга топика; без чата — общая полоса. Тапы по кнопкам
 *  идут своей полосой топика: пока `/close` ждёт выхода сессии, вопрос о фоновых задачах должен
 *  успеть получить ответ кнопкой. */
export function laneOf(update: LaneUpdate): string {
  const message = update.message ?? update.edited_message ?? update.callback_query?.message
  if (message) {
    const reply = message.reply_to_message
    // Ответ на служебное сообщение о создании топика MTProto присылает без thread id.
    const threadId = message.message_thread_id
      ?? reply?.message_thread_id
      ?? (reply?.forum_topic_created ? reply.message_id : undefined)
    const key = messageKey({ chatType: message.chat.type, chatId: String(message.chat.id), threadId })
    return update.callback_query ? `tap:${key}` : key
  }
  if (update.callback_query) {
    return `tap:dm:${update.callback_query.from.id}`
  }
  return update.my_chat_member ? String(update.my_chat_member.chat.id) : 'global'
}

export class Lanes {
  private readonly tails = new Map<string, Promise<void>>()

  /** Поставить задачу в хвост полосы. Ошибку задачи отдаёт возвращённый промис; полосу она не рвёт. */
  run<T>(lane: string, task: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(lane) ?? Promise.resolve()).then(task)
    const tail = result.then(noop, noop)
    this.tails.set(lane, tail)
    void tail.then(() => {
      if (this.tails.get(lane) === tail) {
        this.tails.delete(lane)
      }
    })
    return result
  }

  get busyLanes(): number {
    return this.tails.size
  }
}

function noop(): void {}
