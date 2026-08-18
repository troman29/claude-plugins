// `/send` with a body sends that body. Bare `/send` is useful as a reply: Telegram already
// carries the quoted message, so lift its text/caption without making the user copy it.
export function literalSendText(body?: string, replyText?: string, replyCaption?: string): string | undefined {
  const value = body?.trim() || replyText?.trim() || replyCaption?.trim()
  return value || undefined
}
