import { describe, expect, test } from 'bun:test'
import { normalizeHookMessage } from '../src/hook-normalize'

const keys = ['dm:7']

describe('cross-agent hook normalization', () => {
  test('Claude task events keep their existing protocol', () => {
    expect(normalizeHookMessage('task-create', {
      session_id: 's1', tool_input: { subject: 'Test it' }, tool_response: { task: { id: '42' } },
    }, keys)).toEqual({ op: 'task', action: 'create', bindingKeys: keys, taskId: '42', subject: 'Test it', sessionId: 's1' })
  })

  test('Codex update_plan becomes the shared todo status', () => {
    expect(normalizeHookMessage('codex-plan', { tool_input: { plan: [
      { step: 'Inspect', status: 'completed' }, { step: 'Implement', status: 'in_progress' },
    ] } }, keys)).toEqual({ op: 'todo', bindingKeys: keys, todos: [
      { content: 'Inspect', status: 'completed' }, { content: 'Implement', status: 'in_progress' },
    ] })
  })

  test('Codex skill mention becomes the shared skill status', () => {
    expect(normalizeHookMessage('codex-skill', { prompt: '$openai-docs inspect hooks' }, keys))
      .toEqual({ op: 'skill', bindingKeys: keys, skill: 'openai-docs', args: 'inspect hooks' })
    expect(normalizeHookMessage('codex-skill', { prompt: 'ordinary prompt' }, keys)).toBeUndefined()
  })

  test('Codex compaction hooks retain deterministic lifecycle and trigger', () => {
    expect(normalizeHookMessage('compaction-start', { session_id: 's4', trigger: 'auto' }, keys))
      .toEqual({ op: 'compaction', phase: 'start', bindingKeys: keys, trigger: 'auto', sessionId: 's4' })
    expect(normalizeHookMessage('compaction-done', { session_id: 's4', trigger: 'manual' }, keys))
      .toEqual({ op: 'compaction', phase: 'done', bindingKeys: keys, trigger: 'manual', sessionId: 's4' })
  })

  test('Codex subagent events correlate on turn_id and preserve session id', () => {
    expect(normalizeHookMessage('describe', {
      session_id: 's2', turn_id: 't1', tool_input: { message: 'Review auth', task_name: 'reviewer' },
    }, keys)).toMatchObject({ action: 'describe', promptId: 't1', description: 'Review auth', sessionId: 's2' })
    expect(normalizeHookMessage('start', {
      session_id: 's2', turn_id: 't1', agent_id: 'a1', agent_type: 'reviewer',
    }, keys)).toMatchObject({ action: 'start', promptId: 't1', agentId: 'a1', agentType: 'reviewer', sessionId: 's2' })
  })

  test('Codex spawn_agent payload supplies its task description', () => {
    expect(normalizeHookMessage('describe', {
      session_id: 's3', turn_id: 't2', tool_input: { message: 'Audit delivery', task_name: 'audit_delivery' },
    }, keys)).toEqual({
      op: 'subagent', action: 'describe', bindingKeys: keys, promptId: 't2',
      description: 'Audit delivery', sessionId: 's3',
    })
  })
})
