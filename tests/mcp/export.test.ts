import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendEvent, swarmLogPath } from '../../src/core/log.ts'
import { createExportTools, readAllEvents, renderGif, MAX_FRAMES } from '../../src/mcp/tools/export.ts'
import { Session } from '../../src/mcp/session.ts'
import { fiveAgentEvents, FIVE_SWARM, quietEvents } from '../fixtures/swarm-five.ts'
import { decodeGif } from '../gif/decode.ts'
import { tmpRoot } from '../helpers.ts'

/** 14:05 local time on the machine running the tests: the file name is stamped in local time. */
const NOW = new Date(2026, 9, 22, 14, 5)

test('omnis_export writes .omnis-swarm/exports/<swarm>-<yyyymmdd-hhmm>.gif and answers its path', async () => {
  const root = tmpRoot()
  for (const e of fiveAgentEvents()) appendEvent(root, e)
  const tool = createExportTools({ root, session: new Session(root), now: () => NOW })[0]!
  const out = await tool.handler({ swarm: FIVE_SWARM, style: 'robot' })
  const rel = `.omnis-swarm/exports/${FIVE_SWARM}-20261022-1405.gif`
  assert.match(out.text, new RegExp(rel.replace(/\./g, '\.')))
  const gif = decodeGif(new Uint8Array(readFileSync(join(root, rel))))
  assert.equal(gif.width, 960)
  assert.equal(gif.height, 704)
  const total = gif.frames.reduce((n, f) => n + f.delayCs, 0)
  assert.ok(total >= 300 && total <= 3_000, `clip lasts ${total} cs`)
  assert.ok(gif.frames.at(-1)!.delayCs >= 270, 'ends on the held card (3 fade frames, then 2.7 s)')
})

test('the frame cap raises the speed instead of growing the file', async () => {
  const out = await renderGif(fiveAgentEvents(), FIVE_SWARM, 'globe', { maxFrames: 40, maxBytes: 15 * 1024 * 1024 })
  assert.ok(out.frames <= 40)
  assert.ok(MAX_FRAMES === 600)
})

test('the size cap that cannot be met is an error, not a file', async () => {
  await assert.rejects(renderGif(fiveAgentEvents(), FIVE_SWARM, 'globe', { maxFrames: 600, maxBytes: 1_000 }), /too large/)
})

test('a bad swarm or style is refused; an unknown swarm writes nothing', async () => {
  const root = tmpRoot()
  const tool = createExportTools({ root, session: new Session(root), now: () => NOW })[0]!
  await assert.rejects(async () => tool.handler({ swarm: '../x', style: 'globe' }), { name: 'InputError' })
  await assert.rejects(async () => tool.handler({ swarm: 'ok', style: 'neon' }), { name: 'InputError' })
  await assert.rejects(async () => tool.handler({ swarm: 'absent', style: 'globe' }), { name: 'InputError' })
  assert.equal(existsSync(join(root, '.omnis-swarm', 'exports')), false)
})

test('a second export in the same minute gets -2 and leaves the first in place; no .tmp is left', async () => {
  const root = tmpRoot()
  for (const e of quietEvents()) appendEvent(root, e)
  const tool = createExportTools({ root, session: new Session(root), now: () => NOW })[0]!
  const first = await tool.handler({ swarm: FIVE_SWARM, style: 'globe' })
  const second = await tool.handler({ swarm: FIVE_SWARM, style: 'robot' })
  assert.match(first.text, new RegExp(`${FIVE_SWARM}-20261022-1405\.gif`))
  assert.match(second.text, new RegExp(`${FIVE_SWARM}-20261022-1405-2\.gif`))
  assert.deepEqual(readdirSync(join(root, '.omnis-swarm', 'exports')).sort(), [`${FIVE_SWARM}-20261022-1405-2.gif`, `${FIVE_SWARM}-20261022-1405.gif`])
})

test('a log past the event cap is refused as too long, not cut off', () => {
  const root = tmpRoot()
  for (const e of quietEvents()) appendEvent(root, e)
  assert.throws(() => readAllEvents(swarmLogPath(root, FIVE_SWARM), 3), { name: 'InputError', message: /too long to export/ })
  assert.equal(readAllEvents(swarmLogPath(root, FIVE_SWARM), 7).length, 7)
})
