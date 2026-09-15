// Конверт входящего для агента без нативного входящего канала (Codex): сообщение вписывается
// в его TUI текстом, и по этому же тексту сторож доставки потом находит его в роллауте.

// Инструкция про reply здесь не для красоты: у Codex тул есть, но подсказки MCP-сервера до него
// не доходят, и он отвечает в терминал. Хаб тогда досылает ответ сам, и КАЖДАЯ реплика
// приезжает с плашкой «↩️ auto-forward» — досыл превращается из страховки в норму.
const REPLY_HINT = 'Answer via the telegram `reply` tool (chat_id/thread_id from the tag above); '
  + 'terminal output alone never reaches the user.'

const attr = (name: string, value: string): string => `${name}=${JSON.stringify(value)}`

/** Метка, по которой сторож ищет конверт в транскрипте. Совпадает с тем, как `inboundEnvelope`
 *  пишет `delivery_id` из meta, — поэтому живёт рядом с ним. */
export function deliveryNeedle(id: string): string {
  return attr('delivery_id', id)
}

/** Текст для пейна: `[Telegram message; k="v" …]`, подсказка про reply (если `hint`), тело.
 *  Без meta — голое тело. */
export function inboundEnvelope(content: string, meta: Record<string, string>, hint: boolean): string {
  const details = Object.entries(meta).map(([name, value]) => attr(name, value)).join(' ')
  if (!details) {
    return content
  }
  return `[Telegram message; ${details}]\n${hint ? `${REPLY_HINT}\n` : ''}${content}`
}
