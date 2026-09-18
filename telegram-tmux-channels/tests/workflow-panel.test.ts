import { describe, expect, test } from 'bun:test'
import {
  WORKFLOW_FORGET_MS,
  WORKFLOW_REOPEN_MS,
  workflowCounter,
  workflowStep,
  type WorkflowPanel,
} from '../src/workflow-panel'

const NOW = 1_700_000_000_000
const line = { name: 'cycle-11', done: 0, total: 3 }
const panel = (extra: Partial<WorkflowPanel> = {}): WorkflowPanel => ({
  chatId: '-100', threadId: 447, msgId: 10, bindingKey: '-100/447',
  last: workflowCounter(line), name: line.name, total: line.total, ...extra,
})

describe('workflowStep', () => {
  test('заводит панель на первую строку и молчит без неё', () => {
    expect(workflowStep({ line, now: NOW })).toEqual({ action: 'open' })
    expect(workflowStep({ now: NOW })).toEqual({ action: 'idle' })
  })

  test('правит только сдвинувшийся счётчик', () => {
    expect(workflowStep({ panel: panel(), line, now: NOW }).action).toBe('idle')
    const step = workflowStep({ panel: panel(), line: { ...line, done: 1 }, now: NOW })
    expect(step).toMatchObject({ action: 'edit', done: 1 })
    expect(step.action === 'edit' && step.panel.last).toBe('cycle-11 1/3')
  })

  test('мелькание строки не закрывает живой воркфлоу', () => {
    const gone = workflowStep({ panel: panel(), now: NOW })
    expect(gone).toMatchObject({ action: 'idle' })
    expect(gone.action === 'idle' && gone.panel?.goneSince).toBe(NOW)
    // следующий кадр без строки — всё ещё рано; строка вернулась — панель цела
    const still = workflowStep({ panel: gone.action === 'idle' ? gone.panel! : panel(), now: NOW + 600 })
    expect(still.action).toBe('idle')
    const back = workflowStep({ panel: still.action === 'idle' ? still.panel! : panel(), line, now: NOW + 900 })
    expect(back.action).toBe('idle')
    expect(back.action === 'idle' && back.panel?.goneSince).toBeUndefined()
  })

  test('закрывает, когда строки нет дольше порога', () => {
    const step = workflowStep({ panel: panel({ goneSince: NOW }), now: NOW + WORKFLOW_FORGET_MS })
    expect(step).toMatchObject({ action: 'close' })
    expect(step.action === 'close' && step.panel.closedAt).toBe(NOW + WORKFLOW_FORGET_MS)
  })

  test('вернувшийся воркфлоу правит ТУ ЖЕ панель, а не заводит новую', () => {
    const closed = panel({ closedAt: NOW })
    const step = workflowStep({ panel: closed, line, now: NOW + 1_000 })
    expect(step).toMatchObject({ action: 'edit', done: 0 })
    expect(step.action === 'edit' && step.panel.msgId).toBe(closed.msgId)
    expect(step.action === 'edit' && step.panel.closedAt).toBeUndefined()
  })

  test('закрытая панель ждёт возврата и забывается по таймауту', () => {
    expect(workflowStep({ panel: panel({ closedAt: NOW }), now: NOW + 60_000 })).toMatchObject({ action: 'idle' })
    expect(workflowStep({ panel: panel({ closedAt: NOW }), now: NOW + WORKFLOW_REOPEN_MS })).toEqual({ action: 'forget' })
  })

  test('другой воркфлоу поверх закрытой панели получает свою', () => {
    const step = workflowStep({ panel: panel({ closedAt: NOW }), line: { name: 'cycle-12', done: 0, total: 2 }, now: NOW + 1_000 })
    expect(step).toEqual({ action: 'open' })
  })

  test('пока сообщение отправляется, панель не трогаем', () => {
    expect(workflowStep({ panel: panel({ msgId: -1 }), line: { ...line, done: 2 }, now: NOW }).action).toBe('idle')
    expect(workflowStep({ panel: panel({ msgId: -1 }), now: NOW + WORKFLOW_FORGET_MS }).action).toBe('idle')
  })
})
