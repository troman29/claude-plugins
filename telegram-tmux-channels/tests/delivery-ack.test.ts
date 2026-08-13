// The ack behind delivery: `send()` into a stub is silent, so the hub confirms an inbound by
// finding it in the session transcript. If this stops matching, lost messages go quiet again.
import { describe, expect, test, beforeEach } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { claudeProjectDir, transcriptSawIncoming } from '../src/session-id'

const PROJECT = '/home/user/projects/demo'

function transcript(lines: string[]): void {
  process.env.HOME = mkdtempSync(join(tmpdir(), 'ack-home-'))
  const dir = claudeProjectDir(PROJECT)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'sess.jsonl'), lines.join('\n') + '\n')
}

function userLine(text: string, ts: string): string {
  return JSON.stringify({ type: 'user', timestamp: ts, message: { content: text } })
}

// What Claude Code writes instead of a `user` entry when the message arrives mid-turn:
// text at the top level, and no `user` entry until the turn ends.
function queuedLine(text: string, ts: string): string {
  return JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: ts, content: text })
}

describe('transcriptSawIncoming', () => {
  const now = Date.now()
  const iso = (ms: number) => new Date(ms).toISOString()

  beforeEach(() => {
    transcript([
      userLine('<channel source="telegram" topic_id="7">спулься на актуальный dev</channel>', iso(now)),
      userLine('старое сообщение прошлого хода', iso(now - 600_000)),
    ])
  })

  test('finds the message we just sent', () => {
    expect(transcriptSawIncoming(PROJECT, now, 'спулься на актуальный dev')).toBe(true)
  })
  test('a message that never landed reads as not landed', () => {
    expect(transcriptSawIncoming(PROJECT, now, 'привет')).toBe(false)
  })
  test('an entry older than the send does not count — that is the stale-match trap', () => {
    expect(transcriptSawIncoming(PROJECT, now, 'старое сообщение')).toBe(false)
  })
  test('empty needle = any fresh user entry (media-only message)', () => {
    expect(transcriptSawIncoming(PROJECT, now, '')).toBe(true)
  })
  // The regression this guards: a message sent to a BUSY session is only queued, so watching for
  // `user` alone called every one of them lost — resent it and told the user it never arrived.
  test('queued behind a running turn counts as landed', () => {
    transcript([queuedLine('<channel source="telegram" topic_id="7">Прописал ptr</channel>', iso(now))])
    expect(transcriptSawIncoming(PROJECT, now, 'Прописал ptr')).toBe(true)
  })
  test('a queued entry older than the send still does not count', () => {
    transcript([queuedLine('старое сообщение прошлого хода', iso(now - 600_000))])
    expect(transcriptSawIncoming(PROJECT, now, 'старое сообщение')).toBe(false)
  })
  // Сообщение доходит поздно — уже после того, как сторож сдался и переотправил. Считать
  // надо от ПЕРВОЙ отправки: окно от повторной объявляло такую запись слишком старой и
  // рождало «сообщение не дошло» поверх дошедшего.
  test('запись между попытками: найдена от первой отправки, потеряна от повторной', () => {
    const sent = now
    const retry = now + 40_000
    transcript([queuedLine('<channel source="telegram">Изучи issues/384</channel>', iso(now + 20_000))])
    expect(transcriptSawIncoming(PROJECT, sent, 'Изучи issues/384')).toBe(true)
    expect(transcriptSawIncoming(PROJECT, retry, 'Изучи issues/384')).toBe(false)
  })
  test('no transcript at all → not landed, no throw', () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), 'ack-empty-'))
    expect(transcriptSawIncoming(PROJECT, now, 'привет')).toBe(false)
  })
})
