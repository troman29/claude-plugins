import { chmodSync, existsSync, readFileSync } from 'fs'
import { ENV_FILE } from './paths'

// Токен, админы и настройки хаба из state .env; настоящее окружение главнее.
if (existsSync(ENV_FILE)) {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]!] === undefined) {
      process.env[m[1]!] = m[2]
    }
  }
}
