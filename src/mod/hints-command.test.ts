// src/mod/hints-command.test.ts
import { expect, test, type TestBody } from 'claude-code/testing'
import { RUN, engine } from './test-engine.ts'

const LOADED = { timeoutMs: 60000 }
const start = ($: Parameters<TestBody>[0]) => $.session.start({ cwd: '/p', surface: null, isInteractive: true })

test('/omnis hints asks the server and shows its text', LOADED, async ($, on) => {
  const seen = engine(on)
  seen.onTool = tool => (tool === 'omnis_hints' ? 'Model history (role · model · runs · clean · avg cost · avg minutes · source):\n- dev · Opus · 3 · 3 · ≈$1.00 · 5 · project' : null)
  await start($)
  const reply = await $.command.run({ command: 'omnis', args: 'hints', ...RUN })
  expect(reply.text).toBe('Model history (role · model · runs · clean · avg cost · avg minutes · source):\n- dev · Opus · 3 · 3 · ≈$1.00 · 5 · project')
  expect(seen.calls.find(c => c.tool === 'omnis_hints')!.args).toEqual({})
})

test('/omnis hints with extra words answers the usage and calls nothing', LOADED, async ($, on) => {
  const seen = engine(on)
  await start($)
  expect((await $.command.run({ command: 'omnis', args: 'hints now', ...RUN })).text).toBe('Usage: /omnis hints shows which models past runs did well on.')
  expect(seen.calls.some(c => c.tool === 'omnis_hints')).toBe(false)
})
