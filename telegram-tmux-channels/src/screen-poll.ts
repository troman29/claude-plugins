export function screenPollMs(raw: string | undefined): number {
  const value = raw == null ? 300 : Number(raw)
  return Number.isFinite(value) ? Math.min(5000, Math.max(100, Math.round(value))) : 300
}

export function uniqueByPane<T extends { pane: string }>(rows: T[]): T[] {
  const seen = new Set<string>()
  return rows.filter(row => !seen.has(row.pane) && !!seen.add(row.pane))
}

/** Придержанное сообщение пора выбросить? `date` — время самого сообщения (секунды Telegram).
 *  Даты нет — НЕ протухшее: «не знаю когда» не повод выбросить молча. */
export function isHeldTooLong(date: number | undefined, now: number, maxMs: number): boolean {
  return date != null && now - date * 1000 >= maxMs
}
