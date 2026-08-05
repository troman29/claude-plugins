// ANSI (tmux capture-pane -e) → стилизованные сегменты, из них рисуется /screen (ansi-image.ts).
// Only SGR codes (color/bold/inverse); other escape sequences are stripped.

const BASE16 = [
  '#1e1e1e', '#f44747', '#6a9955', '#d7ba7d', '#569cd6', '#c586c0', '#4ec9b0', '#d4d4d4',
  '#808080', '#f44747', '#6a9955', '#d7ba7d', '#569cd6', '#c586c0', '#4ec9b0', '#ffffff',
]

function color256(n: number): string {
  if (n < 16) {
    return BASE16[n]
  }
  if (n < 232) {
    const v = [0, 95, 135, 175, 215, 255]
    const i = n - 16
    return `rgb(${v[Math.floor(i / 36)]},${v[Math.floor(i / 6) % 6]},${v[i % 6]})`
  }
  const g = 8 + 10 * (n - 232)
  return `rgb(${g},${g},${g})`
}

export const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

type Sgr = { fg?: string; bg?: string; bold?: boolean; reverse?: boolean }
// сегмент = кусок текста одного стиля; reverse уже разрешён в fg/bg
export type Seg = { text: string; fg?: string; bg?: string; bold?: boolean }

export const FG_DEFAULT = '#d4d4d4'
export const BG_DEFAULT = '#1e1e1e'

function seg(text: string, st: Sgr): Seg {
  let { fg, bg } = st
  if (st.reverse) {
    ;[fg, bg] = [bg ?? BG_DEFAULT, fg ?? FG_DEFAULT] // без своих цветов инверсия = тёмным по светлому
  }
  return { text, ...(fg ? { fg } : {}), ...(bg ? { bg } : {}), ...(st.bold ? { bold: true as const } : {}) }
}

function parseSgr(ansi: string): Seg[] {
  // non-SGR escape sequences (OSC, cursor, etc.) — out
  const clean = ansi.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[a-lnzA-Z]|\x1b[^[\]]/g, '')
  let st: Sgr = {}
  const out: Seg[] = []
  let last = 0
  for (const m of clean.matchAll(/\x1b\[([0-9;]*)m/g)) {
    out.push(seg(clean.slice(last, m.index), st))
    last = m.index! + m[0].length
    const codes = (m[1] || '0').split(';').map(Number)
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]
      if (c === 0) {
        st = {}
      } else if (c === 1) {
        st.bold = true
      } else if (c === 7) {
        st.reverse = true
      } else if (c === 22) {
        st.bold = false
      } else if (c === 27) {
        st.reverse = false
      } else if (c >= 30 && c <= 37) {
        st.fg = BASE16[c - 30]
      } else if (c >= 90 && c <= 97) {
        st.fg = BASE16[c - 90 + 8]
      } else if (c === 39) {
        st.fg = undefined
      } else if (c >= 40 && c <= 47) {
        st.bg = BASE16[c - 40]
      } else if (c >= 100 && c <= 107) {
        st.bg = BASE16[c - 100 + 8]
      } else if (c === 49) {
        st.bg = undefined
      } else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
        const col = color256(codes[i + 2] ?? 0)
        c === 38 ? (st.fg = col) : (st.bg = col)
        i += 2
      } else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
        const col = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`
        c === 38 ? (st.fg = col) : (st.bg = col)
        i += 4
      }
    }
  }
  out.push(seg(clean.slice(last), st))
  return out.filter(s => s.text)
}

// то же самое, но разложенное по строкам экрана — как рисует ansi-image
export function ansiSegments(ansi: string): Seg[][] {
  const lines: Seg[][] = [[]]
  for (const s of parseSgr(ansi)) {
    const parts = s.text.split('\n')
    parts.forEach((text, i) => {
      if (i) {
        lines.push([])
      }
      if (text) {
        lines[lines.length - 1]!.push({ ...s, text })
      }
    })
  }
  return lines
}

