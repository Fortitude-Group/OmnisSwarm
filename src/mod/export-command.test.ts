// src/mod/export-command.test.ts
// The kit loads the plugin itself (register.ts), so these tests do not register the pane again.
import type { On } from 'claude-code'
import { expect, mock, test, type TestBody } from 'claude-code/testing'
import { RUN, engine, never, settle } from './test-engine.ts'
import { EXPORT_TIMEOUT_MS } from './export-command.ts'

const LOADED = { timeoutMs: 60000 }
const start = ($: Parameters<TestBody>[0]) => $.session.start({ cwd: '/p', surface: null, isInteractive: true })

function toasting(on: On): string[] {
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  return toasts
}

test('/omnis export gif answers at once and toasts the path when the server is done', LOADED, async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-22T14:05:00.000Z') })
  const seen = engine(on)
  seen.onTool = tool => (tool === 'omnis_export' ? 'Saved C:/p/alpha.gif' : null)
  const toasts = toasting(on)
  await start($)
  expect((await $.command.run({ command: 'omnis', args: 'export gif alpha', ...RUN })).text).toBe('Rendering alpha to a GIF; the path follows when it is done.')
  await settle()
  const call = seen.calls.find(c => c.tool === 'omnis_export')!
  expect(call.args).toEqual({ swarm: 'alpha', style: 'globe' })
  expect(toasts).toEqual(['Saved C:/p/alpha.gif'])
})

test('/omnis export with anything but gif, or a bad swarm word, answers the usage', LOADED, async ($, on) => {
  const seen = engine(on)
  await start($)
  for (const args of ['export png', 'export', 'export gif a b', 'export gif ../x']) {
    expect((await $.command.run({ command: 'omnis', args, ...RUN })).text).toBe('Usage: /omnis export gif [swarm].')
  }
  expect(seen.calls.some(c => c.tool === 'omnis_export')).toBe(false)
})

test('/omnis export gif without a swarm asks for the most recent one, and says so when there is none', LOADED, async ($, on) => {
  const seen = engine(on)
  seen.onTool = tool => (tool === 'omnis_replay' ? JSON.stringify({ v: 1, kind: 'none', recent: [] }) : null)
  await start($)
  expect((await $.command.run({ command: 'omnis', args: 'export gif', ...RUN })).text).toBe('No recorded swarm here yet.')
  expect(seen.calls.find(c => c.tool === 'omnis_replay')!.args).toEqual({ since: 0 })
  expect(seen.calls.some(c => c.tool === 'omnis_export')).toBe(false)
})

test('/omnis export gif without a swarm exports the most recent one', LOADED, async ($, on) => {
  const seen = engine(on)
  seen.onTool = tool => (tool === 'omnis_replay' ? JSON.stringify({ v: 1, kind: 'replay', swarm: 'beta', offset: 0, done: true, events: [], bad: 0 }) : null)
  toasting(on)
  await start($)
  expect((await $.command.run({ command: 'omnis', args: 'export gif', ...RUN })).text).toBe('Rendering beta to a GIF; the path follows when it is done.')
  await settle()
  expect(seen.calls.find(c => c.tool === 'omnis_export')!.args).toEqual({ swarm: 'beta', style: 'globe' })
})

test('/omnis export gif toasts a clear failure when the server never answers', LOADED, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-22T14:05:00.000Z') })
  const seen = engine(on)
  seen.onTool = tool => (tool === 'omnis_export' ? never() : null)
  const toasts = toasting(on)
  await start($)
  await $.command.run({ command: 'omnis', args: 'export gif alpha', ...RUN })
  await clock.advance(EXPORT_TIMEOUT_MS - 1000)
  await settle()
  expect(toasts).toEqual([])
  await clock.advance(2000)
  await settle()
  expect(toasts).toEqual(['GIF export failed: the server did not answer in 5 minutes.'])
})

test('/omnis export gif passes the pane style on', LOADED, async ($, on) => {
  const seen = engine(on)
  toasting(on)
  await start($)
  await $.command.run({ command: 'omnis', args: 'pane style robot', ...RUN })
  await $.command.run({ command: 'omnis', args: 'export gif alpha', ...RUN })
  await settle()
  expect(seen.calls.find(c => c.tool === 'omnis_export')!.args).toEqual({ swarm: 'alpha', style: 'robot' })
})
