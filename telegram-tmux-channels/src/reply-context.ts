export type ReplyContext = { messageId: number; user?: string; text: string }

type TelegramReply = {
  message_id: number
  from?: { id?: number; username?: string; first_name?: string }
  text?: string
  caption?: string
  photo?: unknown
  document?: unknown
  video?: unknown
  audio?: unknown
  voice?: unknown
  sticker?: unknown
  video_note?: unknown
}

const MAX_QUOTE = 1200

export function replyContext(message: TelegramReply | undefined): ReplyContext | undefined {
  if (!message) return undefined
  const kind = ['photo', 'document', 'video', 'audio', 'voice', 'sticker', 'video_note']
    .find(key => message[key as keyof TelegramReply] != null)
  const raw = message.text?.trim() || message.caption?.trim() || (kind ? `[${kind}]` : '[message]')
  const text = raw.length > MAX_QUOTE ? `${raw.slice(0, MAX_QUOTE)}…` : raw
  const user = message.from?.username || message.from?.first_name || (message.from?.id != null ? String(message.from.id) : undefined)
  return { messageId: message.message_id, ...(user ? { user } : {}), text }
}
