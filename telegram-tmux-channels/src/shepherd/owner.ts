// Владелец PR по git: незакрытые биндинги, у которых в dir текущая ветка равна head-ветке PR,
// а origin смотрит в тот же репозиторий.
import type { BindingEntry } from '../registry'

export type Exec = (cmd: string[]) => Promise<{ code: number; stdout: string }>

/** `git@github.com:o/r.git`, `https://github.com/o/r`, `ssh://git@github.com/o/r.git` → `o/r`. */
export function normalizeRemote(url: string): string | undefined {
  const match = /^(?:[\w+.-]+:\/\/)?(?:[^@/]+@)?[^/:]+[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim())
  return match?.[1]?.toLowerCase()
}

async function gitLine(exec: Exec, dir: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await exec(['git', '-C', dir, ...args])
    const line = result.stdout.trim()
    return result.code === 0 && line ? line : undefined
  } catch {
    return undefined // dir исчез или git недоступен: такой биндинг просто не кандидат
  }
}

export async function findByBranch(
  bindings: Record<string, BindingEntry>, repo: string, headRef: string, exec: Exec,
): Promise<string[]> {
  const wantRepo = repo.toLowerCase()
  const matches = await Promise.all(
    Object.entries(bindings)
      .filter(([, binding]) => !binding.closed)
      .map(async ([key, binding]) => {
        const [branch, remote] = await Promise.all([
          gitLine(exec, binding.dir, ['branch', '--show-current']),
          gitLine(exec, binding.dir, ['remote', 'get-url', 'origin']),
        ])
        return branch === headRef && remote && normalizeRemote(remote) === wantRepo ? key : undefined
      }),
  )
  return matches.filter((key): key is string => key !== undefined)
}
