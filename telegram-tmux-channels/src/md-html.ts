// Plain Markdown (as agents write it) → the HTML subset Telegram understands.
// Why HTML, not MarkdownV2: HTML only escapes &<>, so it never drops a message on an
// unescaped special char. Telegram HTML knows only b/i/s/u/code/pre/a/blockquote —
// headings/lists become bold/bullets (Telegram has no tags of its own for them).

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Pull code out of the way so the passes below can't touch it. Fenced ``` first, then inline `…`.
function stashCode(src: string): { text: string; restore: (s: string) => string } {
  const codes: string[] = []
  const text = src
    .replace(/```[^\n]*\n?[\s\S]*?```/g, m => `\x00${codes.push(m) - 1}\x00`)
    .replace(/`[^`\n]+`/g, m => `\x00${codes.push(m) - 1}\x00`)
  return { text, restore: s => s.replace(/\x00(\d+)\x00/g, (_m, i) => codes[Number(i)]) }
}

// Tags Telegram's rich Markdown understands (core.telegram.org/bots/api, Rich HTML style).
const RICH_TAGS = new Set(
  `a b strong i em u ins s strike del code mark sub sup br hr p pre footer cite
   h1 h2 h3 h4 h5 h6 ul ol li input blockquote aside details summary
   img video audio figure figcaption table tr td th caption
   tg-spoiler tg-emoji tg-time tg-math tg-math-block tg-reference tg-map tg-collage tg-slideshow`.split(/\s+/),
)

// Constructs the HTML converter below genuinely cannot express. Everything it merely
// approximates — headings as bold, bullets, ordered lists, quotes — is deliberately absent:
// approximations still read fine, and a rich message carries no `text` field at all, so a
// client that doesn't know the type shows nothing. Rich is worth that risk only for content
// that would otherwise be lost.
const RICH_ONLY: RegExp[] = [
  /^[^\n]*\|[^\n]*\n[ \t]*(?=[^\n]*\|)(?=[^\n]*-)[|\-: \t]+$/m, // table: a row, then a separator
  /<(details|summary|mark|sub|sup|aside|figure|tg-spoiler|tg-math|tg-map|tg-collage|tg-slideshow)\b/i,
  /^\s{0,3}\[\^[^\]\n]+\]:/m, // footnote definition
  /^\s{0,3}\$\$/m, // display math
  /^\s{0,3}```math/m,
  // No space after the opener, or `a == b == c` and `a || b || c` — comparisons and boolean
  // operators an agent wrote outside a code fence — would read as markup.
  /==[^=\s][^=\n]*==/, // marked text
  /\|\|[^|\s][^|\n]*\|\|/, // spoiler
  /^\s{0,3}!\[[^\]\n]*\]\(https?:\/\//m, // media block
]

/** Would this text lose something if sent as plain Telegram HTML instead of a rich message? */
export const needsRich = (src: string): boolean => {
  const { text } = stashCode(src) // a table drawn inside a code fence is just code
  return RICH_ONLY.some(re => re.test(text))
}

/**
 * Make arbitrary agent text safe for the rich-Markdown parser.
 *
 * Two things Telegram does that lose the author's words, both verified against the live API:
 *  - an unsupported HTML tag is dropped SILENTLY — "падает на <Foo>" arrives as "падает на",
 *    with no error, so there is nothing for a fallback to catch;
 *  - "#5" becomes a level-1 heading, though GFM needs a space after the hashes.
 * Escaping is enough for both: `&lt;` renders as a literal `<`, and `\#` as a literal `#`.
 * Code spans and fences are left alone — Telegram already keeps those verbatim.
 */
export function escapeForRich(src: string): string {
  const { text, restore } = stashCode(src)
  const escaped = text
    .replace(/</g, (m, i: number, s: string) => {
      const tag = /^<\/?([a-zA-Z][\w-]*)(?:\s[^<>]*)?\/?>/.exec(s.slice(i))
      return tag && RICH_TAGS.has(tag[1].toLowerCase()) ? m : '&lt;'
    })
    .replace(/^(\s*)(#{1,6})(?=[^\s#])/gm, '$1\\$2')
  return restore(escaped)
}

export function mdToHtml(src: string): string {
  // 1. pull code out (fenced ```…``` first, then inline `…`) into placeholders — inside it
  //    markdown is NOT interpreted, only escaped when spliced back.
  const codes: { pre: boolean; body: string }[] = []
  const stash = (pre: boolean, body: string) => `\x00${codes.push({ pre, body }) - 1}\x00`
  let s = src
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, b) => stash(true, b.replace(/\n$/, '')))
    .replace(/`([^`\n]+)`/g, (_m, b) => stash(false, b))

  // 2. escape HTML in the remaining text
  s = esc(s)

  // 3. markdown → HTML (order matters)
  // &<> in the url were already escaped by step 2 — here we only finish off the attribute quote
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, u) => `<a href="${u.replace(/"/g, '&quot;')}">${t}</a>`)
  s = s.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')            // headings → bold
  s = s.replace(/^(\s*)[-*+]\s+/gm, '$1• ')                  // bullets (before italic — strips the leading *)
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  s = s.replace(/__(.+?)__/g, '<b>$1</b>')
  s = s.replace(/~~(.+?)~~/g, '<s>$1</s>')
  s = s.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, '$1<i>$2</i>')
  s = s.replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?![\w_])/g, '$1<i>$2</i>')

  // 4. restore code (escape the body, but not markdown)
  s = s.replace(/\x00(\d+)\x00/g, (_m, i) => {
    const c = codes[Number(i)]
    return c.pre ? `<pre>${esc(c.body)}</pre>` : `<code>${esc(c.body)}</code>`
  })
  return s
}
