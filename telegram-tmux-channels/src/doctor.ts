export type DoctorLevel = 'ok' | 'warn' | 'fail'

export type DoctorCheck = {
  level: DoctorLevel
  label: string
  detail: string
}

const ICON: Record<DoctorLevel, string> = { ok: '✅', warn: '⚠️', fail: '❌' }

/** Render pre-escaped diagnostic text. Kept pure so probes and presentation stay separate. */
export function renderDoctor(
  header: string,
  checks: DoctorCheck[],
  summary: (ok: number, warn: number, fail: number) => string,
): string {
  const counts = { ok: 0, warn: 0, fail: 0 }
  for (const check of checks) counts[check.level]++
  return [
    header,
    '',
    ...checks.map(check => `${ICON[check.level]} <b>${check.label}</b> — ${check.detail}`),
    '',
    summary(counts.ok, counts.warn, counts.fail),
  ].join('\n')
}
