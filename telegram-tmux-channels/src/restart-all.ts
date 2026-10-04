import type { SessionInfo } from './protocol'
import { uniqueByPane } from './screen-poll'

export type RestartableSession = SessionInfo & { pane: string; pid: number; cmdline: string[] }

export type RestartTarget = { key: string; session: RestartableSession }

export type RestartOutcome = { kind: 'ready' } | { kind: 'not-ready' } | { kind: 'failed'; error: unknown }

export type RestartAllSummary = { ready: string[]; notReady: string[]; failed: string[]; skipped: string[] }

/**
 * Что перезапустит `/restart_all`: живые сессии, поднятые хабом под существующий биндинг, по одной
 * на пейн. Запущенное руками (без `bindingKeys`) в выборку не входит вовсе; биндинг, который уже
 * поднимается, или процесс, который не опознать, — в `skipped`, их ключи идут в итог.
 */
export function selectRestartTargets(
  sessions: SessionInfo[],
  isBound: (key: string) => boolean,
  isSpawning: (key: string) => boolean,
): { targets: RestartTarget[]; skipped: string[] } {
  const bound = uniqueByPane(
    sessions.flatMap(session => {
      const key = session.bindingKeys?.[0]
      return session.pane && key && isBound(key) ? [{ pane: session.pane, key, session }] : []
    }),
  )
  const targets: RestartTarget[] = []
  const skipped: string[] = []
  for (const { key, session } of bound) {
    if (session.pid && session.cmdline?.length && !isSpawning(key)) {
      targets.push({ key, session: session as RestartableSession })
    } else {
      skipped.push(key)
    }
  }
  return { targets, skipped }
}

export function summarizeRestarts(
  results: { key: string; outcome: RestartOutcome }[],
  skipped: string[],
): RestartAllSummary {
  const summary: RestartAllSummary = { ready: [], notReady: [], failed: [], skipped }
  for (const { key, outcome } of results) {
    if (outcome.kind === 'ready') {
      summary.ready.push(key)
    } else if (outcome.kind === 'not-ready') {
      summary.notReady.push(key)
    } else {
      summary.failed.push(key)
    }
  }
  return summary
}
