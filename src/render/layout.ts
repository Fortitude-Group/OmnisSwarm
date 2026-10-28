/** Where each agent sits on the graph canvas, by topology: a tree, a ring, or a hub with spokes. Pure. */
import type { Topology } from '../core/events.ts'
import { LEAD, type AgentState, type SwarmState } from '../core/fold.ts'
import { RASTER_MAX } from './tokens.ts'
import type { Point } from './types.ts'

export type Edge = { from: string; to: string }

/** Pixels kept clear at the canvas edges: room for a node's glow above it and its label row below it. */
export const MARGIN = { x: 6, top: 6, bottom: 8 } as const

type Box = { x0: number; x1: number; y0: number; y1: number }

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const rank = (a: AgentState): number => (a.id === LEAD ? 0 : a.placeholder ? 2 : 1)

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list === undefined) map.set(key, [value])
  else list.push(value)
}

export function orderAgents(state: SwarmState): AgentState[] {
  return Object.values(state.agents).sort((a, b) => rank(a) - rank(b) || a.startedAt - b.startedAt || byId(a.id, b.id))
}

/**
 * Each agent's parent within the swarm, or null for a root. The log is untrusted, so parents can loop: every agent on
 * a loop hangs off the lead instead (or becomes a root when there is no lead). Agents below a loop keep their parent.
 */
export function parentsOf(state: SwarmState): Map<string, string | null> {
  const ids = new Set(Object.keys(state.agents))
  const root = ids.has(LEAD) ? LEAD : null
  const direct = (id: string): string | null => {
    if (id === LEAD) return null
    const p = state.agents[id]?.parent ?? ''
    return p !== '' && p !== id && ids.has(p) ? p : root
  }
  // Linear loop detection: each id is walked once. A path node is on-path until its walk ends, then done.
  const looped = new Set<string>()
  const done = new Set<string>()
  for (const start of ids) {
    if (done.has(start)) continue
    const path: string[] = []
    const at = new Map<string, number>()
    let cur: string | null = start
    while (cur !== null && !done.has(cur)) {
      const pos = at.get(cur)
      if (pos !== undefined) {
        for (let i = pos; i < path.length; i++) looped.add(path[i]!)
        break
      }
      at.set(cur, path.length)
      path.push(cur)
      cur = direct(cur)
    }
    for (const id of path) done.add(id)
  }
  const out = new Map<string, string | null>()
  for (const id of ids) out.set(id, looped.has(id) ? (id === root ? null : root) : direct(id))
  return out
}

/** Steps from each agent up to its root. Bounded, so a loop that slipped through still ends. */
export function depthsOf(parents: Map<string, string | null>): Map<string, number> {
  const out = new Map<string, number>()
  for (const start of parents.keys()) {
    if (out.has(start)) continue
    const path: string[] = []
    const onPath = new Set<string>()
    let cur: string | null = start
    while (cur !== null && !out.has(cur) && !onPath.has(cur)) {
      onPath.add(cur)
      path.push(cur)
      cur = parents.get(cur) ?? null
    }
    // The last path node sits one below a known depth, or at 0 under a root; a loop that slipped through is cut there.
    let d = cur !== null && out.has(cur) ? out.get(cur)! + 1 : 0
    for (let i = path.length - 1; i >= 0; i--) out.set(path[i]!, d++)
  }
  return out
}

/**
 * The tree with every layer wider than `perRow` split into balanced rows, odd rows shifted half a step so links from
 * above pass between the nodes. Rows are spaced evenly down the box, layer by layer.
 */
function wrappedLayout(layers: ReadonlyMap<number, readonly string[]>, perRow: number, box: Box): Record<string, Point> {
  const rows: { ids: readonly string[]; per: number; shift: number }[] = []
  for (const d of [...layers.keys()].sort((a, b) => a - b)) {
    const ids = layers.get(d)!
    const count = Math.ceil(ids.length / perRow)
    const per = Math.ceil(ids.length / count)
    for (let r = 0; r < count; r++) rows.push({ ids: ids.slice(r * per, (r + 1) * per), per, shift: count > 1 && r % 2 === 1 ? 0.5 : 0 })
  }
  const out: Record<string, Point> = {}
  rows.forEach((row, r) => {
    const y = rows.length === 1 ? (box.y0 + box.y1) / 2 : box.y0 + (r / (rows.length - 1)) * (box.y1 - box.y0)
    row.ids.forEach((id, i) => {
      out[id] = { x: box.x0 + ((i + 1 + row.shift) / (row.per + 1)) * (box.x1 - box.x0), y }
    })
  })
  return out
}

function treeLayout(state: SwarmState, agents: readonly AgentState[], box: Box, minGap: number): Record<string, Point> {
  const parents = parentsOf(state)
  const depths = depthsOf(parents)
  const kids = new Map<string, string[]>()
  const roots: string[] = []
  for (const a of agents) {
    const p = parents.get(a.id) ?? null
    if (p === null) roots.push(a.id)
    else push(kids, p, a.id)
  }
  const order: string[] = []
  const seen = new Set<string>()
  // An explicit stack: a chain thousands deep must not overflow the call stack.
  const walk = (start: string): void => {
    const stack = [start]
    while (stack.length > 0) {
      const id = stack.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      order.push(id)
      const k = kids.get(id) ?? []
      for (let i = k.length - 1; i >= 0; i--) stack.push(k[i]!)
    }
  }
  for (const r of roots) walk(r)
  for (const a of agents) walk(a.id)
  const layers = new Map<number, string[]>()
  for (const id of order) push(layers, depths.get(id) ?? 0, id)
  const maxDepth = Math.max(0, ...layers.keys())
  const out: Record<string, Point> = {}
  // Nodes spread evenly sit (x1 - x0) / (count + 1) apart, so a row holds this many at `minGap` or more.
  const perRow = minGap > 0 ? Math.max(1, Math.floor((box.x1 - box.x0) / minGap) - 1) : Number.POSITIVE_INFINITY
  if ([...layers.values()].some(ids => ids.length > perRow)) return wrappedLayout(layers, perRow, box)
  for (const [d, ids] of layers) {
    ids.forEach((id, i) => {
      out[id] = {
        x: box.x0 + ((i + 1) / (ids.length + 1)) * (box.x1 - box.x0),
        y: maxDepth === 0 ? (box.y0 + box.y1) / 2 : box.y0 + (d / maxDepth) * (box.y1 - box.y0),
      }
    })
  }
  return out
}

function ringLayout(agents: readonly AgentState[], box: Box, out: Record<string, Point> = {}): Record<string, Point> {
  const cx = (box.x0 + box.x1) / 2
  const cy = (box.y0 + box.y1) / 2
  const rx = (box.x1 - box.x0) / 2
  const ry = (box.y1 - box.y0) / 2
  if (agents.length === 1) out[agents[0]!.id] = { x: cx, y: cy }
  else {
    agents.forEach((a, i) => {
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / agents.length
      out[a.id] = { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) }
    })
  }
  return out
}

/**
 * Node centres in canvas pixels for a canvas `width` x `height` pixels. A pixel is one cell wide and half a cell tall,
 * so the canvas is held to the Raster limit of 512 columns by 2 x 256 rows. In a tree, a layer that can't keep its
 * nodes `minGap` px apart wraps onto more rows (0, the default, never wraps).
 */
export function layoutNodes(state: SwarmState, topology: Topology, width: number, height: number, minGap = 0): Record<string, Point> {
  const agents = orderAgents(state)
  if (agents.length === 0) return {}
  const finite = (n: number): number => (Number.isFinite(n) ? n : 0)
  const w = Math.min(RASTER_MAX.columns, finite(width))
  const h = Math.min(RASTER_MAX.rows * 2, finite(height))
  const box: Box = { x0: MARGIN.x, x1: Math.max(MARGIN.x, w - MARGIN.x), y0: MARGIN.top, y1: Math.max(MARGIN.top, h - MARGIN.bottom) }
  if (topology === 'hierarchical') return treeLayout(state, agents, box, minGap)
  if (topology === 'star' && agents.length > 1 && agents[0]!.id === LEAD) {
    const out: Record<string, Point> = { [LEAD]: { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 } }
    return ringLayout(agents.slice(1), box, out)
  }
  return ringLayout(agents, box)
}

/** The faint lines that show the swarm's shape: parent links in a tree, spokes in a star, none in a mesh. */
export function structuralEdges(state: SwarmState, topology: Topology): Edge[] {
  const agents = orderAgents(state)
  if (topology === 'mesh' || agents.length < 2) return []
  if (topology === 'star') return agents[0]!.id === LEAD ? agents.slice(1).map(a => ({ from: LEAD, to: a.id })) : []
  const parents = parentsOf(state)
  const edges: Edge[] = []
  for (const a of agents) {
    const p = parents.get(a.id) ?? null
    if (p !== null) edges.push({ from: p, to: a.id })
  }
  return edges
}

/** Callers should cache this per state: it walks every agent's parent chain (O(n x depth)). */
/** Changes exactly when the node set, their order or the tree's shape changes: the pane glides nodes when it does. */
export function nodesKey(state: SwarmState): string {
  const parents = parentsOf(state)
  return `${state.swarm.topology}|${orderAgents(state).map(a => `${a.id}<${parents.get(a.id) ?? ''}`).join(',')}`
}
