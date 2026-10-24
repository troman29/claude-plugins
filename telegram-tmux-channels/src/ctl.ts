// tgc-ctl: управление хабом с той же машины через его сокет — то же, что опс-команда из чата.
//   tgc-ctl restart <chat_id/thread_id>
import { encode, makeLineDecoder, type ControlCommand, type HubToStub } from './protocol'
import { SOCK_PATH } from './paths'

const COMMANDS: ControlCommand[] = ['restart']
// Рестарт ждёт подъёма сессии; хабу на это нужно до пары минут.
const REPLY_TIMEOUT_MS = 180_000

const [command, key] = process.argv.slice(2)
if (!COMMANDS.includes(command as ControlCommand) || !key) {
  console.error(`usage: tgc-ctl ${COMMANDS.join('|')} <chat_id/thread_id>`)
  process.exit(2)
}

const timer = setTimeout(() => {
  console.error('tgc-ctl: no answer from the hub')
  process.exit(1)
}, REPLY_TIMEOUT_MS)

const feed = makeLineDecoder<HubToStub>(msg => {
  if (msg.op !== 'result') {
    return
  }
  clearTimeout(timer)
  console.log(msg.ok ? msg.result : `error: ${msg.error}`)
  process.exit(msg.ok ? 0 : 1)
}, e => console.error(`tgc-ctl: bad message from the hub: ${e}`))

await Bun.connect<undefined>({
  unix: SOCK_PATH,
  socket: {
    open(sock) {
      sock.write(encode({ op: 'control', id: 1, command: command as ControlCommand, key }))
    },
    data(_sock, data) {
      feed(data.toString())
    },
    close() {
      console.error('tgc-ctl: the hub closed the connection')
      process.exit(1)
    },
  },
})
