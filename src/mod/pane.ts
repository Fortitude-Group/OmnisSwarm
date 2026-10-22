/**
 * The swarm pane. /omnis pane (or /omnis-swarm:watch) opens it. While it is placed and shown it pulls omnis_feed at
 * most 4 times a second, folds what arrives and draws render()'s frame: two Rasters with a row of pin chips on the
 * terminal, an Svg of the same cells elsewhere. Informational only: nothing here prompts, runs a tool other than
 * omnis_feed, or writes to the swarm. The chips change only what the pane shows.
 */
import type { On, PluginOptions, RenderElement } from 'claude-code'
import type { Grid } from '../render/grid.ts'
import { CELL_W } from '../render/svg.ts'
import { COMMAND_DESCRIPTION, COMMAND_HINT, runOmnis } from './commands.ts'
import { COMMAND_FAILED, chipRow, maybeAutoOpen, resetAutoOpen } from './pane-commands.ts'
import { animate, closed, frameAt, hooks, mounted, spent, startLive, stopAll, stopFrames, svgSource, waitingText, wakeFor } from './pane-draw.ts'
import { PANE_ID, resume, wake } from './pane-pull.ts'
import { hostOf, loadSaved, panelOf, resetRuntime, rt } from './pane-runtime.ts'

export { PANE_ID }
export { svgSource } from './pane-draw.ts'
/** omnis_swarm_init under any server alias: plugin-bundled (`mcp__plugin_omnis-swarm_omnis-swarm__…`) or from .mcp.json (`mcp__omnis-swarm__…`). */
const SWARM_INIT_TOOL = /^mcp__.+__omnis_swarm_init$/
/** The built-in tool that spawns an agent: with panel auto, a spawn opens the pane as a new swarm does. */
const AGENT_TOOL = 'Agent'

export function registerPane(on: On, options: PluginOptions): void {
  resetRuntime(panelOf(options.panel))
  resetAutoOpen()

  // Matched: the recorder holds the plugin's one unmatched session.start, and only a session with a person at the prompt can show a pane.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const result = await next(e)
    // A new session.start rebinds: the timers of the last one stop, and restart on this one's host if the pane is open.
    stopAll()
    const host = hostOf($)
    rt.host = host
    // Neither is awaited: the session starts whether or not they ever answer.
    void $.command.register({
      name: 'omnis',
      description: COMMAND_DESCRIPTION,
      argumentHint: COMMAND_HINT,
      immediate: true,
    }).catch(() => undefined)
    void resume(hooks, host).catch(() => undefined)
    return result
  })

  on('command.run', { command: 'omnis' }, async ($, e) => ({ text: await runOmnis($, e.args) })).catch(() => COMMAND_FAILED)

  on('command.run', { command: 'omnis-swarm:watch' }, async $ => ({ text: await runOmnis($, 'pane') })).catch(() => COMMAND_FAILED)

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    await loadSaved($)
    rt.surface = e.surface
    rt.open = true
    rt.shown = true
    rt.size = {
      columns: Math.max(1, Math.floor(Number(e.props.bodyColumns) || 1)),
      rows: Math.max(1, Math.floor(Number(e.props.scroll.bodyRows) || 1)),
    }
    if (rt.host !== null) {
      startLive(rt.host)
      // A re-render (a resize, or shown again) means someone is looking: pull at full speed.
      wake(hooks, rt.host)
    }
    const started = Date.now()
    const frame = frameAt(started)
    rt.last = frame
    if (e.surface === 'terminal') {
      const { Box, Text, Button, Raster } = $.ui.resolve(e)
      if (frame === null) {
        mounted(null, null)
        return Text({ dimColor: true, children: waitingText() })
      }
      mounted(frame.top, frame.bottom)
      const tree = Box({
        flexDirection: 'column',
        children: [
          Raster(frame.top.toRaster('top')),
          ...chipRow($, { Box, Text, Button }, frame, rt.size.columns),
          ...(frame.bottom === null ? [] : [Raster(frame.bottom.toRaster('bottom'))]),
        ],
      })
      spent(Date.now() - started)
      if (rt.host !== null) {
        animate(rt.host, frame.fps)
        wakeFor(rt.host, frame)
      }
      return tree
    }
    const { Box, Text, Button, Svg } = $.ui.resolve(e)
    mounted(null, null)
    stopFrames()
    rt.drawnAt = started
    if (frame === null) return Text({ dimColor: true, children: waitingText() })
    const picture = (grid: Grid, key: string): RenderElement => {
      const source = svgSource(grid, frame.alt, typeof Svg === 'function')
      return source === null ? Text({ children: frame.alt }) : Box({ key: `svg-${key}`, children: [Svg({ source, alt: frame.alt, width: grid.columns * CELL_W })] })
    }
    const tree = Box({
      flexDirection: 'column',
      children: [picture(frame.top, 'top'), ...chipRow($, { Box, Text, Button }, frame, rt.size.columns), ...(frame.bottom === null ? [] : [picture(frame.bottom, 'bottom')])],
    })
    // The Svg's frame and source count against the budget too: they space the redraws that news asks for.
    spent(Date.now() - started)
    return tree
  })

  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE_ID) closed(e.origin.kind === 'person')
    return result
  }).catch((_$, e, next) => next(e))

  // With panel auto, a new swarm or a spawned agent (an Agent tool call) opens the pane.
  on('tool.call', { tool: [SWARM_INIT_TOOL, AGENT_TOOL] }, async ($, e, next) => {
    // Started first and not awaited: the pane opens as the agent spawns, and the tool call never waits on it.
    void maybeAutoOpen($).catch(() => {})
    return next(e)
  }).catch((_$, e, next) => next(e)) // next is replay-safe here: once the hook has called it, it returns that result without running the tool again.
}
