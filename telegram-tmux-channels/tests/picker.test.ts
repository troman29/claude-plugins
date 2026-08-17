import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parsePicker, checkedIndexes, pickerCursorIndex, parseResumeList, paneReady, isStartupTrustPrompt, isCodexStartupTrustScreen } from '../src/picker'

const fx = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8')

describe('parsePicker', () => {
  test('Codex 0.147 command approval: options and lowercase footer', () => {
    const pane = `  Would you like to run the following command?\n\n  $ touch /tmp/probe\n\n› 1. Yes, proceed (y)\n  2. Yes, and don't ask again (p)\n  3. No, and tell Codex what to do differently (esc)\n\n  Press enter to confirm or esc to cancel`
    expect(parsePicker(pane)).toMatchObject({
      title: 'Would you like to run the following command? $ touch /tmp/probe',
      mode: 'single',
      options: [
        { index: 1, label: 'Yes, proceed (y)' },
        { index: 2, label: "Yes, and don't ask again (p)" },
        { index: 3, label: 'No, and tell Codex what to do differently (esc)' },
      ],
    })
  })
  test('only an explicit Claude startup-trust picker is auto-acknowledged', () => {
    const trust = parsePicker(fx('startup-prompt.txt'))
    const approval = parsePicker(`  Would you like to run the following command?\n\n› 1. Yes, proceed (y)\n  2. No, cancel (esc)\n\n  Press enter to confirm or esc to cancel`)
    expect(trust).toBeDefined()
    expect(isStartupTrustPrompt(trust!)).toBe(true)
    expect(approval).toBeDefined()
    expect(isStartupTrustPrompt(approval!)).toBe(false)
  })
  test('Codex pre-MCP trust screen is recognised without confusing a regular approval', () => {
    const trust = `> You are in /workspace\n\n  Do you trust the contents of this directory?\n\n› 1. Yes, continue\n  2. No, quit\n\n  Press enter to continue`
    const approval = `Would you like to run this?\n\n› 1. Yes, continue\n  2. No, quit\n\nPress enter to continue`
    expect(isCodexStartupTrustScreen(trust)).toBe(true)
    expect(isCodexStartupTrustScreen(approval)).toBe(false)
  })
  test('Codex 0.147 /model picker: go-back footer and descriptions', () => {
    const pane = `  Select Model and Effort\n  Access legacy models through config.toml\n\n› 1. gpt-5.6-sol (current)  Latest frontier model.\n  2. gpt-5.6-terra          Balanced model.\n  3. gpt-5.6-luna           Fast model.\n\n  Press enter to confirm or esc to go back`
    expect(parsePicker(pane)).toMatchObject({
      title: 'Select Model and Effort Access legacy models through config.toml',
      options: [
        { index: 1, label: 'gpt-5.6-sol (current)' },
        { index: 2, label: 'gpt-5.6-terra' },
        { index: 3, label: 'gpt-5.6-luna' },
      ],
    })
  })
  test('single /model: options, mode, no custom', () => {
    const p = parsePicker(fx('model-single.txt'))!
    expect(p.mode).toBe('single')
    expect(p.options.map(o => o.index)).toEqual([1, 2, 3, 4, 5])
    expect(p.options[3].label).toBe('Sonnet')
    expect(p.customIndex).toBeUndefined()
  })
  test('single AskUserQuestion: label without description, custom=Type something', () => {
    const p = parsePicker(fx('ask-single.txt'))!
    expect(p.mode).toBe('single')
    expect(p.title).toContain('Tea or coffee?')
    expect(p.options).toEqual([
      { index: 1, label: 'Tea' },
      { index: 2, label: 'Coffee' },
      { index: 3, label: 'Type something.' },
      { index: 4, label: 'Chat about this' },
    ])
    expect(p.customIndex).toBe(3)
  })
  test('multi: checkboxes → mode multi, label without [ ]', () => {
    const p = parsePicker(fx('ask-multi.txt'))!
    expect(p.mode).toBe('multi')
    expect(p.options[0]).toEqual({ index: 1, label: 'Python' })
    expect(p.customIndex).toBe(4)
  })
  test('typed custom value keeps the custom slot and picker identity stable', () => {
    const before = parsePicker(fx('ask-multi.txt'))!
    const after = parsePicker(fx('ask-multi.txt').replace('Type something.', 'TTC_DIRECT_CUSTOM'))!
    expect(after.customIndex).toBe(4)
    expect(after.hash).toBe(before.hash)
  })
  test('pickerCursorIndex reads the visible cursor without mistaking an ordinary option for it', () => {
    expect(pickerCursorIndex(fx('ask-multi.txt'))).toBe(1)
    expect(pickerCursorIndex('  1. Alpha\n  2. Beta')).toBeUndefined()
  })
  test('plain text without a picker → undefined', () => {
    expect(parsePicker('just a prompt\n❯ \n')).toBeUndefined()
  })
  test('stale footer: leftover «Esc to cancel» with a prompt box under it → not a picker', () => {
    expect(parsePicker(fx('stale-footer.txt'))).toBeUndefined()
  })
  test('live picker + foreign trailing chrome (echoed telegram messages, task widget) under the footer → still a picker', () => {
    const p = parsePicker(fx('live-with-trailing-chrome.txt'))!
    expect(p.options.map(o => o.label)).toEqual(['Back to text', 'Keep voice as is', 'Type something.', 'Chat about this'])
  })
  test('scrollback: a numbered list ABOVE the picker does not leak into options/title', () => {
    const p = parsePicker(fx('scrollback-noise.txt'))!
    expect(p.options.map(o => o.label)).toEqual(['Migrate', 'Roll back', 'Type something.'])
    expect(p.title).toBe("What's the next step?")
    expect(p.title).not.toContain('back up')
  })
  test('dialog with no options (Rewind) → not a picker, agent output above is not harvested', () => {
    expect(parsePicker(fx('dialog-without-options.txt'))).toBeUndefined()
  })
  test('paneReady: startup prompt is not ready, a drawn input prompt is', () => {
    expect(paneReady(fx('startup-prompt.txt'))).toBe(false) // модалка на старте
    expect(paneReady(fx('ask-single.txt'))).toBe(false) // ❯ есть, но это вариант в модалке
    expect(paneReady('● Готово.\n\n❯ \n\n  ⏵⏵ bypass permissions on\n')).toBe(true)
  })
  test('hash is stable and distinguishes pickers', () => {
    expect(parsePicker(fx('ask-single.txt'))!.hash).toBe(parsePicker(fx('ask-single.txt'))!.hash)
    expect(parsePicker(fx('ask-single.txt'))!.hash).not.toBe(parsePicker(fx('ask-multi.txt'))!.hash)
  })
})

describe('checkedIndexes', () => {
  test('reads [✔] from multi', () => {
    expect(checkedIndexes(fx('ask-multi.txt'))).toEqual([2])
  })
  test('single without checkboxes → []', () => {
    expect(checkedIndexes(fx('ask-single.txt'))).toEqual([])
  })
})

describe('parseResumeList', () => {
  test('real /resume snapshot: rows, cursor, total', () => {
    const l = parseResumeList(fx('resume-list.txt'))!
    expect(l.total).toBe('1 of 27')
    expect(l.cursor).toBe(0)
    expect(l.rows.map(r => r.title)).toEqual([
      '(session)',
      'commit changes in homelab and the plugin',
      'Remind me of the last two days of work',
      'Set up Telegram binding for Claude server',
    ])
    expect(l.rows[1].meta).toBe('1 day ago · main · 6.9MB')
  })
  test('plain screen without a list → undefined', () => {
    expect(parseResumeList(fx('model-single.txt'))).toBeUndefined()
    expect(parseResumeList('')).toBeUndefined()
  })
})
