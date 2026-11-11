import { join } from 'path'
import { describe, expect, test } from 'bun:test'
import { tempDir } from './shepherd-helpers'

const CTL = join(import.meta.dir, '..', 'src', 'ctl.ts')

describe('tgc-ctl pr-own', () => {
  test('sends the control op with the session key from TELEGRAM_BINDING_KEYS and prints the hub answer', async () => {
    const stateDir = tempDir()
    const received: unknown[] = []
    const server = Bun.listen<undefined>({
      unix: join(stateDir, 'hub.sock'),
      socket: {
        data(sock, data) {
          const msg = JSON.parse(data.toString().trim())
          received.push(msg)
          sock.write(JSON.stringify({ op: 'result', id: msg.id, ok: true, result: 'owner -100/42' }) + '\n')
        },
      },
    })
    try {
      const proc = Bun.spawn(['bun', CTL, 'pr-own', 'https://github.com/o/r/pull/5'], {
        env: { ...process.env, TELEGRAM_STATE_DIR: stateDir, TELEGRAM_BINDING_KEYS: '-100/42,-100/43' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(await proc.exited).toBe(0)
      expect((await new Response(proc.stdout).text()).trim()).toBe('owner -100/42')
      expect(received).toEqual([{ op: 'control', id: 1, command: 'pr-own', key: '-100/42', arg: 'https://github.com/o/r/pull/5' }])
    } finally {
      server.stop(true)
    }
  })

  test('without a key it exits with usage', async () => {
    const proc = Bun.spawn(['bun', CTL, 'pr-own', 'https://github.com/o/r/pull/5'], {
      env: { ...process.env, TELEGRAM_STATE_DIR: tempDir(), TELEGRAM_BINDING_KEYS: '' }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(await proc.exited).toBe(2)
  })
})
