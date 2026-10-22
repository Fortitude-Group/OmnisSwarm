/** The pane's state and the host it binds from `$`: shared by the drawing (pane-draw.ts) and the commands (pane-commands.ts). */
import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Timer } from 'claude-code'
import type { SwarmEvent } from '../core/events.ts'
import type { Grid } from '../render/grid.ts'
import type { Frame, Size, Spot, Tween } from '../render/types.ts'
import { emptyModel, type PaneModel } from './pane-model.ts'
import type { PullHost, PullState } from './pane-pull.ts'
import { connectServer } from './server.ts'

export const pinnedAtom = atom({ plugin: 'omnis-swarm', key: 'panePinned' } as const, null)
/** $.state may hold anything (a corrupt or older file): only text is a pin, anything else is no pin. */
export const pinText = (x: unknown): string | null => (typeof x === 'string' ? x : null)
/** The node style, pane-wide (pane.md 12.1), kept as the pin is. Anything stored but `robot` is the default, globes. */
export const styleAtom = atom({ plugin: 'omnis-swarm', key: 'paneStyle' } as const, null)
export type Style = 'globe' | 'robot'
export const styleOf = (x: unknown): Style => (x === 'robot' ? 'robot' : 'globe')

export type Panel = 'command' | 'auto' | 'off'
export type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>
export type BlitArgs = Parameters<EngineInterface['ui']['blit']>[0]

/**
 * What the timers and blits need from the engine. The engine refuses a module that keeps `$` itself, so session.start
 * binds this from its `$` (as RuFlo's pane does) and the module keeps the closures.
 */
export type Host = PullHost & { blit: (args: BlitArgs) => Promise<void> }

/** Binds a Host from `$`, each member spelled `$.noun.event(...)`. A refused redraw is not a crashed timer; a refused blit rejects, for blitFrame to see. */
export function hostOf($: EngineInterface): Host {
  return {
    every: (ms, fn) => $.clock.every(ms, fn),
    after: (ms, fn) => $.clock.after(ms, fn),
    invalidate: () => {
      try {
        $.ui.invalidate('ui.render')
      } catch {
        // A refused redraw leaves the last frame on screen.
      }
    },
    blit: args => {
      try {
        return $.ui.blit(args).then(() => undefined)
      } catch (err) {
        return Promise.reject(err)
      }
    },
    panes: () => $.ui.panes(),
    connect: () => connectServer($),
    call: (server, tool, args) => $.mcp.call(server, tool, args),
  }
}

/**
 * A replay playing in the pane (replay.ts): the events re-timed onto the replay clock, with the log time and replay
 * offset of each, when it started, how far it has folded into its own model, its tick timer, and whether it has ended.
 * `looking`/`sinceLook`: a look at $.ui.panes() in flight, and the ms since the last began, counted in tick periods.
 * `lookMs`: once ended, the period of the look-only timer that replaced the tick. `drawnSecond`: the clock second last drawn.
 */
export type ReplayRun = {
  swarm: string; speed: number; events: SwarmEvent[]; logTs: number[]; offsets: number[]; startMs: number; cursor: number
  model: PaneModel; timer: Timer | null; ended: boolean; looking: boolean; sinceLook: number; lookMs: number; drawnSecond: number
}

export type Runtime = PullState & {
  panel: Panel
  host: Host | null
  closedByPerson: boolean
  /**
   * The frame loop and its period; how long the last frame took to draw and hand over on any path (it spaces the next
   * frame), and the moving average of that (it sets the motion cap).
   */
  frameTimer: Timer | null; frameMs: number; renderMs: number; renderAvgMs: number
  /** One frame scheduled outside the loop's rate (a robot's blink edge), and the time it is for. */
  wakeTimer: Timer | null; wakeAt: number
  style: Style
  /** Off the terminal: when the pane last asked for a redraw, and the redraw held back by the budget, if one is. */
  drawnAt: number; redrawWait: Timer | null
  spot: Spot | null
  tween: Tween | null
  pinned: string | null
  surface: string | null
  size: Size | null
  last: Frame | null
  /**
   * The grid each Raster shows now, as mounted or last blitted. A blit of another size is refused, so none is sent;
   * one with the same cells would change nothing, so none is sent either.
   */
  onScreen: { top: Grid | null; bottom: Grid | null }
  /** Per Raster: the last blit sent, and whether the engine refused it, so the next frame sends its cells again. */
  blitId: { top: number; bottom: number }; refused: { top: boolean; bottom: boolean }
  /** The replay on screen in place of the live swarm, or null when the pane is live. */
  replay: ReplayRun | null
}

export const panelOf = (x: unknown): Panel => (x === 'auto' || x === 'off' ? x : 'command')
export const fresh = (panel: Panel): Runtime => ({
  panel, host: null, open: false, shown: false, closedByPerson: false, server: null, model: emptyModel(), pulling: false, pullSeq: 0, stalledMs: 0, stallMarked: false,
  pullTimer: null, pullMs: 0, connectWait: null, connectBackoffMs: 0, quiet: 0, unreadableMs: 0,
  frameTimer: null, frameMs: 0, renderMs: 0, renderAvgMs: 0, wakeTimer: null, wakeAt: 0, style: 'globe', drawnAt: 0, redrawWait: null, spot: null, tween: null, pinned: null, surface: null, size: null, last: null,
  onScreen: { top: null, bottom: null }, blitId: { top: 0, bottom: 0 }, refused: { top: false, bottom: false }, replay: null,
})

/** Module state. A hot reload starts it over and the pane pulls a fresh state within one PULL_MS; the pin is in $.state. */
export let rt: Runtime = fresh('command')

/** Starts the pane's state over (registerPane does, once per load). Importers see the new value: ES bindings are live. */
export function resetRuntime(panel: Panel): void {
  rt = fresh(panel)
}

/** Reads the saved pin and node style into the state. The reads sit beside the atoms: the mod checker wants a literal atom in the file that reads it. */
export async function loadSaved($: EngineInterface): Promise<void> {
  rt.pinned = pinText(await read($, pinnedAtom))
  rt.style = styleOf(await read($, styleAtom))
}

/** The saved node style, read afresh: /omnis export asks before the pane has ever rendered (loadSaved runs at ui.render). */
export async function readStyle($: EngineInterface): Promise<Style> {
  return styleOf(await read($, styleAtom).catch(() => null))
}

/** Saves the node style; rejects when it could not be saved. */
export async function saveStyle($: EngineInterface, style: Style): Promise<void> {
  await update($, styleAtom, () => style)
}

/** Pins the agent, or unpins it when it is the pinned one. */
export async function togglePin($: EngineInterface, id: string): Promise<void> {
  await update($, pinnedAtom, current => (current === id ? null : id))
}
