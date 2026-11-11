// Первым: модули ниже читают настройки хаба (TELEGRAM_LAUNCH_CMD) из env прямо при загрузке.
import './state-env'
import { agentAdapter } from './agents'
import { launcherDir, launchScript, parseLaunchArgs } from './launch'
import { loadBindings } from './registry'

const req = parseLaunchArgs(process.argv.slice(2))
const binding = loadBindings()[req.keys[0]!]
if (!binding) {
  throw new Error(`no binding ${req.keys[0]}`)
}
const adapter = agentAdapter(binding.agent)
process.stdout.write(launchScript({
  dir: binding.dir,
  env: adapter.launchEnv(req.keys),
  ...(adapter.envFile ? { envFile: adapter.envFile } : {}),
  pathPrepend: launcherDir(), // обёртка gh раньше настоящего gh — только у сессий хаба
  argv: adapter.buildLaunch(binding.cmdline, req.mode, req.sessionId),
}))
