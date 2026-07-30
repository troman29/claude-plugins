// Rendering for the single per-binding status bubble: agents, tasks, todos, skills and
// background shells share ONE self-editing message. Separate messages per tracker meant a
// busy turn pinged Telegram four times; one bubble pings once and then only edits.
// Pure — no I/O, no hub state. Tested in tests/status-render.test.ts.
import { escHtml } from './ansi-html'
import { t } from './i18n'

export type SubagentStatus = { name: string; done: boolean }
export type TaskStatus = { subject: string; status: string }
export type Todo = { content: string; status: string }
export type SkillCall = { skill: string; args?: string }
export type BgTask = { command: string; description?: string }

export type StatusState = {
  agents: Map<string, SubagentStatus> // agentId -> status
  tasks: Map<string, TaskStatus> // taskId -> status
  todos: Todo[] // TodoWrite carries the full list each call — no per-item lifecycle
  skills: SkillCall[] // append-only within a batch
  bg: BgTask[] // append-only: no hook fires when a background shell finishes
}

export const emptyStatus = (): StatusState => ({
  agents: new Map(),
  tasks: new Map(),
  todos: [],
  skills: [],
  bg: [],
})

export const statusIsEmpty = (s: StatusState): boolean =>
  s.agents.size === 0 && s.tasks.size === 0 && s.todos.length === 0 && s.skills.length === 0 && s.bg.length === 0

// A batch stays open while any subagent is still running — a run_in_background agent outlives
// the Stop hook, so "turn ended" alone must not close the bubble it is reporting into.
export const hasLiveWork = (s: StatusState): boolean => [...s.agents.values()].some(a => !a.done)

const MAX_LINES = 25
const cap = (lines: string[]): string[] =>
  lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `… +${lines.length - MAX_LINES}`] : lines

const glyph = (s: string): string => (s === 'completed' ? '✅' : s === 'in_progress' ? '🟡' : '⏳')

function agentLines(items: SubagentStatus[]): string[] {
  // Collapse identical names into one line with a counter — a workflow spawns dozens of
  // same-named subagents, otherwise the status becomes a wall.
  const groups = new Map<string, { done: number; total: number }>()
  for (const i of items) {
    const g = groups.get(i.name) ?? { done: 0, total: 0 }
    g.total++
    if (i.done) g.done++
    groups.set(i.name, g)
  }
  return [...groups].map(([name, g]) => {
    const mark = g.done === g.total ? '✅' : '🟡'
    const suffix = g.total === 1 ? '' : g.done === g.total ? ` ×${g.total}` : ` ${g.done}/${g.total}`
    return `${mark} ${escHtml(name)}${suffix}`
  })
}

export function renderStatus(s: StatusState): string {
  const sections: string[] = []
  if (s.agents.size) {
    sections.push([t().agentsHeader, '', ...cap(agentLines([...s.agents.values()]))].join('\n'))
  }
  if (s.tasks.size) {
    sections.push([t().tasksHeader, '', ...cap([...s.tasks.values()].map(i => `${glyph(i.status)} ${escHtml(i.subject)}`))].join('\n'))
  }
  if (s.todos.length) {
    sections.push([t().todosHeader, '', ...cap(s.todos.map(i => `${glyph(i.status)} ${escHtml(i.content)}`))].join('\n'))
  }
  if (s.bg.length) {
    sections.push([t().bgHeader, '', ...cap(s.bg.map(i => t().bgLine(escHtml(i.description || i.command))))].join('\n'))
  }
  if (s.skills.length) {
    sections.push(cap(s.skills.map(i => t().skillLine(escHtml(i.skill), i.args ? escHtml(i.args) : ''))).join('\n'))
  }
  return sections.join('\n\n')
}
