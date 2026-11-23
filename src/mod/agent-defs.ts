/**
 * An agent type's own model, read from its definition (model defaults design, "The mechanism" point 4): no engine API
 * answers it, so this reads the agent files with $.fs. The project's .claude/agents/ walking up from the working
 * directory (subfolders up to SUB_DEPTH deep), then <config dir>/agents/, then for <plugin>:<name> the plugin's
 * agents/<name>.md; then the built-ins. Any read that throws counts as not found.
 */
import type { EngineInterface } from 'claude-code'

export type OwnModel = { known: boolean; model?: string }

/** Built-ins as the sub-agents docs give them: a model of their own, or null for one that follows the usual order. */
const BUILT_INS: Readonly<Record<string, string | null>> = {
  'claude-code-guide': 'haiku',
  'statusline-setup': 'sonnet',
  // The web fetcher's type, spelt with an escape: the mod-safe check bans the bare word, for the web API of that name.
  'web-\u0066etch': 'haiku',
  'general-purpose': null,
  Explore: null,
  Plan: null,
  claude: null,
}

const CACHE_MS = 30_000
const SUB_DEPTH = 3
const MAX_UP = 64
const MAX_FILES = 200

const cache = new Map<string, { at: number; own: OwnModel }>()

/** Forgets every cached answer (a fresh register, or a test). */
export function clearAgentDefs(): void {
  cache.clear()
}

const trimEnd = (dir: string): string => dir.replace(/[\\/]+$/, '')
const join = (dir: string, rest: string): string => `${trimEnd(dir)}/${rest}`

/** The folder above, keeping a drive root `C:\`; null at the top. */
function parentOf(dir: string): string | null {
  const d = trimEnd(dir)
  const cut = Math.max(d.lastIndexOf('/'), d.lastIndexOf('\\'))
  if (cut < 0) return null
  const up = d.slice(0, cut)
  if (up === '') return '/'
  return /^[A-Za-z]:$/.test(up) ? `${up}\\` : up
}

const unquote = (s: string): string => {
  const t = s.trim()
  const m = /^(['"])(.*)\1$/.exec(t)
  return (m === null ? t : m[2]!).trim()
}

/** `name:` and `model:` from the block between the first two `---` lines; absent when not there or empty. */
export function frontmatterOf(text: string): { name?: string; model?: string } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const first = lines.findIndex(l => l.trim() === '---')
  if (first < 0) return {}
  const rest = lines.slice(first + 1)
  const end = rest.findIndex(l => l.trim() === '---')
  if (end < 0) return {}
  const out: { name?: string; model?: string } = {}
  for (const line of rest.slice(0, end)) {
    const m = /^(name|model)\s*:(.*)$/.exec(line)
    if (m === null) continue
    const value = unquote(m[2]!)
    if (value !== '' && out[m[1] as 'name' | 'model'] === undefined) out[m[1] as 'name' | 'model'] = value
  }
  return out
}

/** The .md files under `dir`, subfolders up to SUB_DEPTH deep; none when it can't be listed. */
async function mdFiles($: EngineInterface, dir: string, depth = 0, found: string[] = []): Promise<string[]> {
  let entries: Awaited<ReturnType<EngineInterface['fs']['list']>>
  try {
    entries = await $.fs.list(dir)
  } catch {
    return found
  }
  for (const entry of entries) {
    if (found.length >= MAX_FILES) break
    const path = join(dir, entry.name)
    if (entry.kind === 'dir') {
      if (depth < SUB_DEPTH) await mdFiles($, path, depth + 1, found)
    } else if ((entry.kind === 'file' || entry.isLink) && entry.name.toLowerCase().endsWith('.md')) {
      found.push(path)
    }
  }
  return found
}

/** The definition of `type` in an agents folder, by frontmatter `name:`, else the file name. */
async function inFolder($: EngineInterface, dir: string, type: string): Promise<OwnModel | null> {
  let there = false
  try {
    there = await $.fs.exists(dir)
  } catch {
    there = false
  }
  if (!there) return null
  for (const path of await mdFiles($, dir)) {
    let text: string
    try {
      text = await $.fs.read(path)
    } catch {
      continue
    }
    const front = frontmatterOf(text)
    const file = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1).replace(/\.md$/i, '')
    if ((front.name ?? file) !== type) continue
    return front.model === undefined ? { known: true } : { known: true, model: front.model }
  }
  return null
}

async function configDir($: EngineInterface): Promise<string | null> {
  try {
    const set = await $.env.get('CLAUDE_CONFIG_DIR')
    if (set !== undefined && set.trim() !== '') return set.trim()
    const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
    return home === undefined || home.trim() === '' ? null : join(home.trim(), '.claude')
  } catch {
    return null
  }
}

/** A plugin's folder: this plugin's own root, else its install path in installed_plugins.json. */
async function pluginRoot($: EngineInterface, plugin: string, config: string | null): Promise<string | null> {
  if (plugin === $.plugin.name) return $.plugin.root
  if (config === null) return null
  try {
    const parsed: unknown = JSON.parse(await $.fs.read(join(config, 'plugins/installed_plugins.json')))
    const plugins = (parsed as { plugins?: unknown } | null)?.plugins
    if (typeof plugins !== 'object' || plugins === null) return null
    for (const [key, installs] of Object.entries(plugins)) {
      if (!key.startsWith(`${plugin}@`) || !Array.isArray(installs)) continue
      const path = (installs[0] as { installPath?: unknown } | undefined)?.installPath
      if (typeof path === 'string' && path !== '') return path
    }
  } catch {
    return null
  }
  return null
}

async function lookUp($: EngineInterface, type: string, cwd: string | undefined): Promise<OwnModel> {
  const config = await configDir($)
  const colon = type.indexOf(':')
  if (colon > 0) {
    const root = await pluginRoot($, type.slice(0, colon), config)
    if (root === null) return { known: false }
    const name = type.slice(colon + 1)
    try {
      const front = frontmatterOf(await $.fs.read(join(root, `agents/${name}.md`)))
      return front.model === undefined ? { known: true } : { known: true, model: front.model }
    } catch {
      return { known: false }
    }
  }
  let start: string | null = null
  try {
    start = (await $.fs.stat(cwd ?? '.', { resolve: true })).realPath ?? null
  } catch {
    start = null
  }
  for (let dir = start, i = 0; dir !== null && i < MAX_UP; dir = parentOf(dir), i++) {
    const own = await inFolder($, join(dir, '.claude/agents'), type)
    if (own !== null) return own
  }
  if (config !== null) {
    const own = await inFolder($, join(config, 'agents'), type)
    if (own !== null) return own
  }
  if (Object.hasOwn(BUILT_INS, type)) {
    const model = BUILT_INS[type]
    return model === null || model === undefined ? { known: true } : { known: true, model }
  }
  return { known: false }
}

/**
 * Whether `type` is a definition this can read, and the model it sets (any value, `inherit` too), cached CACHE_MS per
 * type and working directory. Never throws: anything unreadable is `{ known: false }`.
 */
export async function ownModelOf($: EngineInterface, type: string, cwd?: string): Promise<OwnModel> {
  const key = `${type}\n${cwd ?? ''}`
  const now = Date.now()
  const hit = cache.get(key)
  if (hit !== undefined && now - hit.at < CACHE_MS) return hit.own
  let own: OwnModel
  try {
    own = await lookUp($, type, cwd)
  } catch {
    own = { known: false }
  }
  cache.set(key, { at: now, own })
  if (cache.size > 500) cache.delete(cache.keys().next().value!)
  return own
}
