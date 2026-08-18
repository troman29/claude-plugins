// Снимок залогиненного Telegram Web для визуальных проверок (см. docs/testing/README.md).
//
//   bun scripts/tg-shot.ts "https://web.telegram.org/a/#<chatId>_<topicId>" out.png 28000
//
// Браузер поднимает и ГАСИТ сам: своя копия chrome на свободном порту с профилем-водителем
// (ему нужен залогиненный Telegram, поэтому общий agent-chrome на :9225 не подходит). Ждём
// реальные секунды, а не `--virtual-time-budget`: тот на больших значениях отдаёт пустой кадр.
//
// Навигация внутри WebA — по hash: чтобы открыть другой топик, сперва сходи на about:blank,
// иначе смена только хвоста адреса оставляет открытым прежний экран.
import { rmSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const PROFILE = process.env.TG_PROFILE || join(homedir(), '.cache/ms-playwright-mcp/telegram-profile')
const PORT = Number(process.env.CDP_PORT || 9231)
const [target, out, waitMs = '25000'] = process.argv.slice(2)
if (!target || !out) {
  throw new Error('usage: bun scripts/tg-shot.ts <url> <out.png> [waitMs]')
}

rmSync(join(PROFILE, 'SingletonLock'), { force: true }) // остался от прошлого запуска — chrome иначе не стартует
const chrome = Bun.spawn([
  'google-chrome', '--headless=new', `--user-data-dir=${PROFILE}`,
  `--window-size=${process.env.TG_WIDTH || 900},${process.env.TG_HEIGHT || 1500}`, `--remote-debugging-port=${PORT}`, 'about:blank',
], { stdout: 'ignore', stderr: 'ignore' })

async function cdp(path: string): Promise<any> {
  return (await fetch(`http://127.0.0.1:${PORT}${path}`)).json()
}

try {
  let page
  for (let i = 0; i < 200 && !page; i++) {
    page = await cdp('/json/list').then(list => list.find((t: any) => t.type === 'page')).catch(() => undefined)
    if (!page) await Bun.sleep(100)
  }
  if (!page) {
    throw new Error(`chrome не открыл CDP на :${PORT}`)
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map<number, (v: any) => void>()
  ws.onmessage = e => {
    const msg = JSON.parse(String(e.data))
    pending.get(msg.id)?.(msg.result)
  }
  await new Promise(r => (ws.onopen = () => r(null)))
  const send = (method: string, params: any = {}) =>
    new Promise<any>(res => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })) })
  await send('Page.navigate', { url: target })
  await Bun.sleep(Number(waitMs))
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  await Bun.write(out, Buffer.from(shot.data, 'base64'))
  console.log('ok', out)
} finally {
  chrome.kill() // без этого браузер переживёт скрипт — так они и копятся сутками
}
process.exit(0)
