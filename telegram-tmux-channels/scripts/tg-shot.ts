// Снимок залогиненного Telegram Web для визуальных проверок (см. docs/testing/README.md).
//
//   google-chrome --headless=new --user-data-dir=<профиль> --window-size=900,1500 \
//     --remote-debugging-port=9222 about:blank &
//   bun scripts/tg-shot.ts "https://web.telegram.org/a/#<chatId>_<topicId>" out.png 28000
//
// Навигация внутри WebA — по hash: чтобы открыть другой топик, сперва сходи на about:blank,
// иначе смена только хвоста адреса оставляет открытым прежний экран.
const [target, out, waitMs = '25000'] = process.argv.slice(2)
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t: any) => t.type === 'page')
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
process.exit(0)
