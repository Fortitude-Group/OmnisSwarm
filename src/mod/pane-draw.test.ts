import { expect, test } from 'claude-code/testing'
import { emptyState, type SwarmState } from '../core/fold.ts'
import { emptyModel } from './pane-model.ts'
import { resetRuntime, rt } from './pane-runtime.ts'
import { RENDER_FAILED_TEXT, safeFrameAt, waitingText } from './pane-draw.ts'
import { KIT } from './test-engine.ts'

// An agent entry that is null makes render() throw (it reads fields off every agent), as a render bug would.
const broken = (): SwarmState => ({ ...emptyState('s1'), agents: { a1: null } }) as unknown as SwarmState

test('a render that throws marks the pane render-failed, and the note says so instead of "Waiting for the swarm"', KIT, async () => {
  resetRuntime('command')
  rt.size = { columns: 120, rows: 44 }
  rt.model = { ...emptyModel(), swarm: 's1', state: broken() }
  expect(safeFrameAt(1_000)).toBe(null)
  expect(rt.model.degraded).toBe('render-failed')
  expect(waitingText()).toBe(RENDER_FAILED_TEXT)
  expect(RENDER_FAILED_TEXT.includes('Waiting for the swarm')).toBe(false)
})

test('the next frame that draws clears render-failed', KIT, async () => {
  resetRuntime('command')
  rt.size = { columns: 120, rows: 44 }
  rt.model = { ...emptyModel(), swarm: 's1', state: emptyState('s1'), degraded: 'render-failed' }
  expect(safeFrameAt(1_000)).not.toBe(null)
  expect(rt.model.degraded).toBe(null)
})

test('an unreadable read still says "Waiting for the swarm"', KIT, async () => {
  resetRuntime('command')
  rt.model = { ...emptyModel(), degraded: 'unreadable' }
  expect(waitingText()).toBe('⚠ Waiting for the swarm…')
})
