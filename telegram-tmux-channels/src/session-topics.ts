// Какой сессии какой топик. bindings.json помнит только текущую сессию живого биндинга: после
// `/unbind`, `/delete` или очередного `/new` связь терялась, и в списке «какую сессию поднять»
// было не понять, из какого топика каждая. Источники связи, от сильного к слабому: запись хаба,
// когда он узнал id сессии топика; тег канала в первом сообщении из Telegram в транскрипте.
import { readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { messageKey } from './bindings'
import { STATE_DIR } from './paths'
import { safeJsonParse } from './util'

export type TopicRef = { chatId: string; threadId?: number }

export type SessionChoice = { id: string; label: string }

type ListedSession = { id: string; mtime: number; snippet: string; origin?: TopicRef }

const INDEX_FILE = 'session-topics.json'
const OWN_TOPIC_MARK = '📍'
const SNIPPET_CHARS = 40
const TITLE_CHARS = 20

// Claude: `<channel source="telegram" chat_id="…" … topic_id="…">`. Codex: `[Telegram message; chat_id="…" … topic_id="…"]`.
const ENVELOPE_RE = /(?:<channel\s+source="telegram"|\[Telegram message;)([^>\]]*)/

/** Чат и топик из конверта сообщения Telegram в тексте хода; без конверта — undefined. */
export function telegramOrigin(text: string): TopicRef | undefined {
  const attrs = ENVELOPE_RE.exec(text)?.[1]
  const chatId = attrs && /\bchat_id="([^"]+)"/.exec(attrs)?.[1]
  if (!chatId) {
    return undefined
  }
  const topic = /\btopic_id="(\d+)"/.exec(attrs)?.[1]
  return topic ? { chatId, threadId: Number(topic) } : { chatId }
}

/** Ключ биндинга по конверту. Тип чата конверт не несёт: положительный id — личка. */
export function originKey(origin: TopicRef): string {
  const chatType = origin.chatId.startsWith('-') ? 'supergroup' : 'private'
  return messageKey({ chatType, chatId: origin.chatId, threadId: origin.threadId })
}

export function loadSessionTopics(): Record<string, string> {
  try {
    return safeJsonParse<Record<string, string>>(readFileSync(join(STATE_DIR, INDEX_FILE), 'utf8')) ?? {}
  } catch {
    return {}
  }
}

/** Запомнить сессии биндингов за их топиками. Последний владелец побеждает: сессию бывает, что
 *  поднимают в другом топике. Запись в индексе живёт дольше биндинга — ради неё он и нужен. */
export function rememberSessionTopics(bindings: Record<string, { sessionId?: string }>): void {
  const index = loadSessionTopics()
  const fresh = Object.entries(bindings).filter(([key, binding]) => binding.sessionId && index[binding.sessionId] !== key)
  if (fresh.length === 0) {
    return
  }
  for (const [key, binding] of fresh) {
    index[binding.sessionId!] = key
  }
  const path = join(STATE_DIR, INDEX_FILE)
  writeFileSync(`${path}.tmp`, JSON.stringify(index))
  renameSync(`${path}.tmp`, path)
}

/** Кнопки выбора сессии: сначала сессии этого топика, потом остальные — с именем их топика. */
export function sessionChoices(opts: {
  sessions: ListedSession[]
  key: string
  index: Record<string, string>
  titleOf: (key: string) => string | undefined
  limit: number
}): SessionChoice[] {
  const { sessions, key, index, titleOf, limit } = opts
  const withTopic = sessions.map(session => ({
    session,
    topic: index[session.id] ?? (session.origin ? originKey(session.origin) : undefined),
  }))
  const own = withTopic.filter(entry => entry.topic === key)
  const others = withTopic.filter(entry => entry.topic !== key)
  const byTime = (a: { session: ListedSession }, b: { session: ListedSession }) => b.session.mtime - a.session.mtime
  return [...own.sort(byTime), ...others.sort(byTime)].slice(0, limit).map(({ session, topic }) => ({
    id: session.id,
    label: choiceLabel(session, topic === key ? OWN_TOPIC_MARK : topic && titleOf(topic)),
  }))
}

function choiceLabel(session: ListedSession, place: string | undefined): string {
  const when = new Date(session.mtime).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  const where = place === OWN_TOPIC_MARK ? `${OWN_TOPIC_MARK} ` : place ? `«${place.slice(0, TITLE_CHARS)}» ` : ''
  return `⏪ ${when} · ${where}${session.snippet.slice(0, SNIPPET_CHARS) || session.id.slice(0, 8)}`
}
