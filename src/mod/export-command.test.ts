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

test('/omnis export gif without a swarm reads a full-size replay page, not just its first 300 characters', LOADED, async ($, on) => {
  const seen = engine(on)
  const tool = (i: number) => ({ v: 1, ts: `2026-10-21T22:47:${String(i % 60).padStart(2, '0')}.000Z`, swarm: 'gamma', src: 'recorder', type: 'agent.tool', agent: 'lead', data: { phase: 'start', tool: 'Read', kind: 'read', subject: `src/file-${i}.ts`, isError: false } })
  const page = JSON.stringify({ v: 1, kind: 'replay', swarm: 'gamma', offset: 9000, done: false, events: Array.from({ length: 40 }, (_, i) => tool(i)), bad: 0 })
  expect(page.length).toBeGreaterThan(5000)
  seen.onTool = name => (name === 'omnis_replay' ? page : null)
  toasting(on)
  await start($)
  expect((await $.command.run({ command: 'omnis', args: 'export gif', ...RUN })).text).toBe('Rendering gamma to a GIF; the path follows when it is done.')
  await settle()
  expect(seen.calls.find(c => c.tool === 'omnis_export')!.args).toEqual({ swarm: 'gamma', style: 'globe' })
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

test('/omnis export gif passes the saved pane style on, even before the pane has rendered', LOADED, async ($, on) => {
  const seen = engine(on)
  toasting(on)
  on('state.get', (_, e) => ({ value: { value: String(e.key) === 'paneStyle' ? 'robot' : undefined, version: 0 } }))
  await start($)
  await $.command.run({ command: 'omnis', args: 'export gif alpha', ...RUN })
  await settle()
  expect(seen.calls.find(c => c.tool === 'omnis_export')!.args).toEqual({ swarm: 'alpha', style: 'robot' })
})

test('a finished export cancels its timer: no second toast after the ceiling', LOADED, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-22T14:05:00.000Z') })
  const seen = engine(on)
  seen.onTool = tool => (tool === 'omnis_export' ? 'Saved C:/p/alpha.gif' : null)
  const toasts = toasting(on)
  await start($)
  await $.command.run({ command: 'omnis', args: 'export gif alpha', ...RUN })
  await settle()
  await clock.advance(EXPORT_TIMEOUT_MS + 1000)
  await settle()
  expect(toasts).toEqual(['Saved C:/p/alpha.gif'])
})

test('an empty success toasts GIF saved', LOADED, async ($, on) => {
  const seen = engine(on)
  seen.onTool = tool => (tool === 'omnis_export' ? '' : null)
  const toasts = toasting(on)
  await start($)
  await $.command.run({ command: 'omnis', args: 'export gif alpha', ...RUN })
  await settle()
  expect(toasts).toEqual(['GIF saved.'])
})

test('an error reply toasts its text as a failure', LOADED, async ($, on) => {
  const seen = engine(on)
  seen.onTool = tool => (tool === 'omnis_export' ? 'no such swarm' : null)
  seen.errorTool = 'omnis_export'
  const toasts = toasting(on)
  await start($)
  await $.command.run({ command: 'omnis', args: 'export gif alpha', ...RUN })
  await settle()
  expect(toasts).toEqual(['GIF export failed: no such swarm'])
})

test('a call that rejects toasts that the server did not answer', LOADED, async ($, on) => {
  const seen = engine(on)
  seen.onTool = tool => {
    if (tool === 'omnis_export') throw new Error('Connection closed')
    return null
  }
  const toasts = toasting(on)
  await start($)
  await $.command.run({ command: 'omnis', args: 'export gif alpha', ...RUN })
  await settle()
  expect(toasts).toEqual(['GIF export failed: the server did not answer.'])
})

test('the default-swarm lookup gives up after 15 seconds', LOADED, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-22T14:05:00.000Z') })
  const seen = engine(on)
  seen.onTool = tool => (tool === 'omnis_replay' ? never() : null)
  await start($)
  const run = $.command.run({ command: 'omnis', args: 'export gif', ...RUN })
  await settle()
  await clock.advance(15_000)
  await settle()
  expect((await run).text).toBe('The swarm server did not answer in time; try again in a moment.')
  expect(seen.calls.some(c => c.tool === 'omnis_export')).toBe(false)
})
