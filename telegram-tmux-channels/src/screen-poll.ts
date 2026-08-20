export function screenPollMs(raw: string | undefined): number {
  const value = raw == null ? 300 : Number(raw)
  return Number.isFinite(value) ? Math.min(5000, Math.max(100, Math.round(value))) : 300
}

export function uniqueByPane<T extends { pane: string }>(rows: T[]): T[] {
  const seen = new Set<string>()
  return rows.filter(row => !seen.has(row.pane) && !!seen.add(row.pane))
}

/** Ключ живого пейна tmux (`%12`). Предстартовый пикер висит на цели сессии (`=имя:`), и
 *  почистить его «раз пейна нет в снимке» нельзя: снимок его не содержит никогда, а снос
 *  каждый тик означал бы пересылку кнопок в чат по три раза в секунду. */
export function isLivePaneKey(key: string): boolean {
  return key.startsWith('%')
}
