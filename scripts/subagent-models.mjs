#!/usr/bin/env node
// Which model each subagent really answered on, from Claude Code's own session logs.
//
//   node scripts/subagent-models.mjs [--from 2026-11-13] [--to 2026-11-20] [--project <dir name>] [--session <id>] [--json]
//
// For every subagent log (~/.claude/projects/<project>/<session>/subagents/agent-*.jsonl) it reads the type and
// description from the .meta.json beside it, finds the lead's Agent call by its toolUseId to see whether a `model` was
// passed, and counts the models on the subagent's own assistant messages, which record the model that answered.
// Read-only. Prints one row per subagent and a summary.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const opt = name => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const from = opt('from') ? Date.parse(`${opt('from')}T00:00:00Z`) : -Infinity
const to = opt('to') ? Date.parse(`${opt('to')}T23:59:59.999Z`) : Infinity
const onlyProject = opt('project')
const onlySession = opt('session')
const asJson = args.includes('--json')
const root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')

const lines = file => {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean)
  } catch {
    return []
  }
}

/** Every Agent tool_use in a session's main log, by id: its input. */
function agentCalls(sessionFile) {
  const calls = new Map()
  for (const m of lines(sessionFile)) {
    const content = m?.message?.content
    if (m.type !== 'assistant' || !Array.isArray(content)) continue
    for (const b of content) if (b?.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task')) calls.set(b.id, b.input ?? {})
  }
  return calls
}

const rows = []
for (const project of existsSync(root) ? readdirSync(root) : []) {
  if (onlyProject !== undefined && project !== onlyProject) continue
  const pdir = join(root, project)
  let entries
  try { entries = readdirSync(pdir) } catch { continue }
  for (const session of entries) {
    if (onlySession !== undefined && session !== onlySession) continue
    const sub = join(pdir, session, 'subagents')
    if (!existsSync(sub) || !statSync(sub).isDirectory()) continue
    let calls = null
    for (const f of readdirSync(sub)) {
      if (!f.endsWith('.jsonl')) continue
      const log = lines(join(sub, f))
      const first = log.find(m => typeof m.timestamp === 'string')
      const at = first ? Date.parse(first.timestamp) : NaN
      if (!(at >= from && at <= to)) continue
      let meta = {}
      try { meta = JSON.parse(readFileSync(join(sub, f.replace(/\.jsonl$/, '.meta.json')), 'utf8')) } catch {}
      calls ??= agentCalls(join(pdir, `${session}.jsonl`))
      const input = meta.toolUseId ? calls.get(meta.toolUseId) : undefined
      // One response is written as several lines (a line per content block), all with the same message id, so count ids.
      const models = {}
      const counted = new Set()
      for (const m of log) {
        const model = m?.message?.model
        const id = m?.message?.id ?? m.uuid
        if (m.type !== 'assistant' || typeof model !== 'string' || model === '<synthetic>' || counted.has(id)) continue
        counted.add(id)
        models[model] = (models[model] ?? 0) + 1
      }
      rows.push({
        at: new Date(at).toISOString(), project, session, agent: f.replace(/^agent-|\.jsonl$/g, ''),
        type: meta.agentType ?? input?.subagent_type ?? '?', description: meta.description ?? input?.description ?? '',
        passed: input === undefined ? '?' : (input.model ?? null), models,
      })
    }
  }
}
rows.sort((a, b) => a.at.localeCompare(b.at))

if (asJson) {
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
} else {
  for (const r of rows) {
    const answered = Object.entries(r.models).map(([m, n]) => `${m} x${n}`).join(', ') || 'none'
    console.log(`${r.at}  ${r.type.padEnd(24)} passed=${String(r.passed).padEnd(7)} answered: ${answered}  "${r.description}"`)
  }
  const byPassed = {}
  for (const r of rows) {
    const k = r.passed === null ? '(none)' : String(r.passed)
    const top = Object.entries(r.models).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'none'
    byPassed[k] ??= {}
    byPassed[k][top] = (byPassed[k][top] ?? 0) + 1
  }
  console.log(`\n${rows.length} subagents.`)
  for (const [k, v] of Object.entries(byPassed)) console.log(`  model passed ${k}: answered on ${Object.entries(v).map(([m, n]) => `${m} ${n}`).join(', ')}`)
}
