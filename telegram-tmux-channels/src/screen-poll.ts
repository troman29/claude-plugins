export function screenPollMs(raw: string | undefined): number {
  const value = raw == null ? 300 : Number(raw)
  return Number.isFinite(value) ? Math.min(5000, Math.max(100, Math.round(value))) : 300
}

export function uniqueByPane<T extends { pane: string }>(rows: T[]): T[] {
  const seen = new Set<string>()
  return rows.filter(row => !seen.has(row.pane) && !!seen.add(row.pane))
}
