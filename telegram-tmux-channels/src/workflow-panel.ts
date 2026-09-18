// Решение про панель воркфлоу в топике: завести, поправить счётчик, объявить готовым. Источник
// один и слабый — строка статуса в хвосте пейна, которая пропадает из кадра и на живом
// воркфлоу: перерисовка TUI, вывод агента, пустой кадр от упавшего `capture-pane`. Поэтому
// «готов» — по ВРЕМЕНИ без строки, а закрытая панель ещё переиспользуется: вернулась строка
// того же воркфлоу — правим ЕЁ сообщение, иначе топик получает новую панель на каждое мелькание.
// Чистая — тесты в workflow-panel.test.ts.

/** Сколько пейн должен быть без строки, чтобы воркфлоу считался законченным. Именно время,
 *  а не число тиков: счётчик молча поменял смысл, когда опрос ускорили до 300 мс, и панель
 *  закрывалась через 0.6 с (та же грабля, что у баннеров ошибок — ERROR_FORGET_MS). */
export const WORKFLOW_FORGET_MS = 15_000
/** Сколько закрытая панель ждёт возврата своей строки, прежде чем её забыть. */
export const WORKFLOW_REOPEN_MS = 10 * 60_000

export type WorkflowPanel = {
  chatId: string
  threadId?: number
  /** -1 — сообщение ещё отправляется. */
  msgId: number
  bindingKey: string
  /** Последний показанный счётчик — правку шлём, только когда он сдвинулся. */
  last: string
  name: string
  total: number
  /** Когда строка впервые пропала из кадра; нет — она на месте. */
  goneSince?: number
  /** Когда панель объявили готовой; такая переиспользуется при возврате той же строки. */
  closedAt?: number
}

export type WorkflowLine = { name: string; done: number; total: number }

/** `panel` у всех исходов, кроме `open` и `forget`, — состояние, которое надо сохранить. */
export type WorkflowStep =
  | { action: 'open' }
  | { action: 'edit'; panel: WorkflowPanel; done: number }
  | { action: 'close'; panel: WorkflowPanel }
  | { action: 'forget' }
  | { action: 'idle'; panel?: WorkflowPanel }

export const workflowCounter = (line: WorkflowLine): string => `${line.name} ${line.done}/${line.total}`

export function workflowStep(opts: { panel?: WorkflowPanel; line?: WorkflowLine; now: number }): WorkflowStep {
  const { panel, line, now } = opts
  if (!panel) {
    return line ? { action: 'open' } : { action: 'idle' }
  }
  if (panel.closedAt != null) {
    if (line && line.name !== panel.name) {
      return { action: 'open' } // другой воркфлоу — своя панель
    }
    if (now - panel.closedAt >= WORKFLOW_REOPEN_MS) {
      return { action: 'forget' }
    }
    if (!line) {
      return { action: 'idle', panel }
    }
    // Сообщение сейчас показывает «готов» — правим его, даже если счётчик тот же.
    const revived = { ...panel, last: workflowCounter(line), name: line.name, total: line.total }
    delete revived.closedAt
    delete revived.goneSince
    return { action: 'edit', panel: revived, done: line.done }
  }
  if (line) {
    const counter = workflowCounter(line)
    const live = { ...panel, name: line.name, total: line.total }
    delete live.goneSince
    if (panel.msgId === -1 || panel.last === counter) {
      return { action: 'idle', panel: live } // ещё отправляется, или счётчик не сдвинулся
    }
    return { action: 'edit', panel: { ...live, last: counter }, done: line.done }
  }
  if (panel.msgId === -1) {
    return { action: 'idle', panel }
  }
  const goneSince = panel.goneSince ?? now
  if (now - goneSince < WORKFLOW_FORGET_MS) {
    return { action: 'idle', panel: { ...panel, goneSince } }
  }
  return { action: 'close', panel: { ...panel, goneSince, closedAt: now } }
}
