// /screen: ANSI пейна → картинка прямой отрисовкой (skia), без headless-браузера.
// Стек шрифтов, а не один: моношрифт не покрывает рамки/галки/эмодзи, которые рисует Claude Code.
// JPEG, а не PNG: кодек втрое быстрее на кадр (~70 мс против ~200), а Telegram всё равно
// пережимает фото в JPEG сам — лишняя точность выбрасывается на его стороне.

import { createCanvas } from '@napi-rs/canvas'
import { ansiSegments, FG_DEFAULT, BG_DEFAULT, type Seg } from './ansi'

const SIZE = 14
const LINE_H = 19
const PAD = 12
const MAX_W = 2400
const FAMILIES =
  '"DejaVu Sans Mono", "Noto Sans Mono CJK SC", "Noto Color Emoji", "Noto Sans Symbols2", "Symbola", monospace'
const font = (bold?: boolean) => `${bold ? 'bold ' : ''}${SIZE}px ${FAMILIES}`

export function ansiToImage(ansi: string): Promise<Buffer> {
  const lines = ansiSegments(ansi.replace(/\s+$/, ''))
  // мерка на одноразовом холсте: ширина зависит от реальных advance'ов (эмодзи шире клетки)
  const probe = createCanvas(1, 1).getContext('2d')
  const widths = lines.map(segs =>
    segs.map(s => {
      probe.font = font(s.bold)
      return probe.measureText(s.text).width
    }),
  )
  const lineW = widths.map(ws => ws.reduce((a, b) => a + b, 0))
  const width = Math.min(Math.ceil(Math.max(...lineW, 80 * SIZE * 0.6)) + PAD * 2, MAX_W)
  const canvas = createCanvas(width, LINE_H * lines.length + PAD * 2)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = BG_DEFAULT
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.textBaseline = 'top'
  lines.forEach((segs, row) => {
    const y = PAD + row * LINE_H
    let x = PAD
    ;(segs as Seg[]).forEach((s, i) => {
      ctx.font = font(s.bold)
      const w = widths[row]![i]!
      if (s.bg) {
        ctx.fillStyle = s.bg
        ctx.fillRect(x, y, w, LINE_H)
      }
      ctx.fillStyle = s.fg ?? FG_DEFAULT
      ctx.fillText(s.text, x, y)
      x += w
    })
  })
  return canvas.encode('jpeg', 92) // async: кодек уходит в пул потоков, поллинг бота не встаёт
}
