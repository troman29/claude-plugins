import type { Mux, MuxKind } from './types'
import { tmuxMux } from './tmux'
import { herdrMux } from './herdr'

export type { Mux, MuxKind } from './types'

const MUXES: Record<MuxKind, Mux> = { tmux: tmuxMux, herdr: herdrMux }

/** Мультиплексор хоста: `TELEGRAM_MUX=herdr` или tmux по умолчанию. Один на всех: хаб и стаб
 *  обязаны смотреть в один и тот же, иначе стаб назовёт пейн, которого хаб не знает. */
export function mux(): Mux {
  const kind = process.env.TELEGRAM_MUX?.trim()
  return kind === 'herdr' ? MUXES.herdr : MUXES.tmux
}

/** Id пейна из окружения — какой бы мультиплексор его ни запустил: стабу не нужно знать хаба. */
export function paneFromAnyEnv(read: (key: string) => string | undefined): string | undefined {
  return tmuxMux.paneFromEnv(read) ?? herdrMux.paneFromEnv(read)
}
