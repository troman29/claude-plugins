import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shellQuote, typeText } from '../src/tmux-ops'

test('tmux delivers long Unicode transcripts byte-for-byte without submitting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-long-text-'))
  const session = `telegram-test-${crypto.randomUUID()}`
  const received = join(dir, 'received')
  const ready = join(dir, 'ready')
  const start = Bun.spawn(['tmux', 'new-session', '-d', '-P', '-F', '#{pane_id}', '-s', session,
    `stty raw -echo; touch ${shellQuote([ready])}; exec cat > ${shellQuote([received])}`],
  { stdout: 'pipe', stderr: 'pipe' })
  try {
    expect(await start.exited).toBe(0)
    const pane = (await new Response(start.stdout).text()).trim()
    for (let i = 0; i < 100 && !existsSync(ready); i++) await Bun.sleep(20)
    expect(existsSync(ready)).toBe(true)
    // Empty, leading option-like text, newlines, and emoji across chunk boundaries.
    await typeText(pane, '')
    const text = '--literal\n' + 'а'.repeat(989) + '🎙️\n$(literal) `text` '.repeat(4000)
    await typeText(pane, text)
    for (let i = 0; i < 100 && readFileSync(received).byteLength < Buffer.byteLength(text); i++) await Bun.sleep(20)
    expect(readFileSync(received).equals(Buffer.from(text))).toBe(true)
  } finally {
    await Bun.spawn(['tmux', 'kill-session', '-t', `=${session}`], { stderr: 'ignore' }).exited
    rmSync(dir, { recursive: true, force: true })
  }
}, 15000)
