import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const hubPath = join(import.meta.dir, '../src/hub.ts')
const key = '-100/42'
const sessionId = '93d64c47-1d75-4a27-8279-164ffc533361'

test('web wake resumes only the selected saved conversation and deduplicates concurrent requests', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hub-terminal-wake-'))
  try {
    const project = join(directory, 'project')
    const bin = join(directory, 'bin')
    const transcriptDir = join(directory, '.claude', 'projects', project.replace(/[^A-Za-z0-9]/g, '-'))
    const launchLog = join(directory, 'launch.log')
    const foregroundFile = join(directory, 'foreground')
    for (const path of [bin, transcriptDir, project]) {
      mkdirSync(path, { recursive: true })
    }
    writeFileSync(join(directory, 'bindings.json'), JSON.stringify({ [key]: { dir: project, tmux: 'test-window', sessionId } }))
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh
case "$1" in
  list-windows) printf 'test-window\\n' ;;
  display-message) /usr/bin/cat "$TERMINAL_TEST_FOREGROUND" ;;
  send-keys) printf '%s\\n' "$*" >> "$TERMINAL_TEST_LOG" ;;
  *) exit 3 ;;
esac
`, { mode: 0o700 })
    const script = `
      import assert from 'node:assert/strict';
      import { readFileSync, writeFileSync, existsSync } from 'node:fs';
      const { handleStubMessage } = await import(${JSON.stringify(hubPath)});
      const request = { op: 'terminal-wake', id: 1, key: ${JSON.stringify(key)}, sessionId: ${JSON.stringify(sessionId)}, cwd: ${JSON.stringify(project)} };
      async function wake(overrides = {}) {
        let reply;
        await handleStubMessage({ write: frame => { reply = JSON.parse(frame) } }, { ...request, ...overrides });
        assert.equal(reply?.ok, true);
        return reply.result;
      }
      const launchLog = ${JSON.stringify(launchLog)};
      assert.equal(await wake({ cwd: '/other-folder' }), 'changed');
      assert.equal(await wake(), 'history-unavailable');
      assert.equal(existsSync(launchLog), false);
      writeFileSync(${JSON.stringify(join(transcriptDir, sessionId + '.jsonl'))}, '{}\\n');
      const foregroundFile = ${JSON.stringify(foregroundFile)};
      writeFileSync(foregroundFile, 'codex\\n');
      assert.equal(await wake(), 'failed');
      assert.equal(existsSync(launchLog), false);
      writeFileSync(foregroundFile, 'bash\\n');
      assert.deepEqual(await Promise.all([wake(), wake()]), ['starting', 'starting']);
      const launches = readFileSync(launchLog, 'utf8').split('\\n').filter(line => line.includes('tgc-run'));
      assert.equal(launches.length, 1);
      assert.match(launches[0], new RegExp('resume.*' + request.sessionId));
      process.exit(0);
    `
    const child = Bun.spawn([process.execPath, '-e', script], { env: { ...process.env, HOME: directory,
      TELEGRAM_STATE_DIR: directory, TELEGRAM_BOT_TOKEN: '123:TEST', TELEGRAM_MUX: 'tmux', TELEGRAM_DEBUG_LOG: '0',
      TERMINAL_TEST_LOG: launchLog, TERMINAL_TEST_FOREGROUND: foregroundFile, PATH: bin + ':' + process.env.PATH,
    }, stdout: 'ignore', stderr: 'pipe', signal: AbortSignal.timeout(5000) })
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(exitCode, stderr).toBe(0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
