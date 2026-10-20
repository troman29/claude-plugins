import { describe, expect, test } from 'bun:test'
import { herdrKeyBatches, herdrMux } from '../src/mux/herdr'
import { tmuxMux } from '../src/mux/tmux'
import { paneFromAnyEnv } from '../src/mux'

describe('мультиплексор: id пейна против предстартовой цели', () => {
  // Чистилка тика сносит состояние пейнов, которых нет в снимке; предстартовой цели в снимке
  // не бывает никогда — её она трогать не должна.
  test('tmux', () => {
    expect(tmuxMux.isPaneId('%12')).toBe(true)
    expect(tmuxMux.isPaneId(tmuxMux.prestartTarget('homelab-channels'))).toBe(false)
    expect(tmuxMux.prestartTarget('homelab-channels')).toBe('=agents:=homelab-channels')
  })

  test('herdr', () => {
    expect(herdrMux.isPaneId('w12:p3')).toBe(true)
    expect(herdrMux.isPaneId(herdrMux.prestartTarget('homelab-channels'))).toBe(false)
  })
})

describe('стаб узнаёт свой пейн в любом мультиплексоре', () => {
  const env = (vars: Record<string, string>) => (key: string) => vars[key]
  test('tmux, herdr и ни один', () => {
    expect(paneFromAnyEnv(env({ TMUX_PANE: '%7' }))).toBe('%7')
    expect(paneFromAnyEnv(env({ HERDR_PANE_ID: 'w1:p1' }))).toBe('w1:p1')
    expect(paneFromAnyEnv(env({}))).toBeUndefined()
  })
})

describe('клавиши хаба на языке herdr', () => {
  test('именованные и ctrl-клавиши идут одним send-keys, текст — send-text', () => {
    expect(herdrKeyBatches(['C-x', 'C-s'])).toEqual([{ kind: 'keys', values: ['ctrl+x', 'ctrl+s'] }])
    expect(herdrKeyBatches(['Escape', 'Enter', 'Down', 'BSpace'])).toEqual([
      { kind: 'keys', values: ['esc', 'enter', 'down', 'backspace'] },
    ])
    expect(herdrKeyBatches(['/model', 'Enter'])).toEqual([
      { kind: 'text', values: ['/model'] },
      { kind: 'keys', values: ['enter'] },
    ])
  })

  test('цифра пикера — клавиша, а не текст', () => {
    expect(herdrKeyBatches(['3', 'Enter'])).toEqual([{ kind: 'keys', values: ['3', 'enter'] }])
  })
})
