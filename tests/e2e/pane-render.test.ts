import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFeedReply } from '../../src/core/feed-reply.ts'
import { appendEvent, writeCurrent } from '../../src/core/log.ts'
import { swarmTotals } from '../../src/core/stats.ts'
import { Session } from '../../src/mcp/session.ts'
import { createFeedTools } from '../../src/mcp/tools/feed.ts'
import { applyReply, emptyModel, feedArgs, type PaneModel } from '../../src/mod/pane-model.ts'
import { fmtTokens } from '../../src/render/format.ts'
import { render } from '../../src/render/frame.ts'
import { gridText } from '../../src/render/grid.ts'
import { emptyView } from '../../src/render/types.ts'
import { FIVE_AT, FIVE_SWARM, fiveAgentEvents } from '../fixtures/swarm-five.ts'
import { tmpRoot } from '../helpers.ts'

test('a scripted five-agent swarm goes from the log through omnis_feed and the pane model to a drawn frame', () => {
  const root = tmpRoot()
  const events = fiveAgentEvents()
  for (const e of events.slice(0, 30)) assert.ok(appendEvent(root, e))
  writeCurrent(root, FIVE_SWARM)
  const feed = createFeedTools({ root, session: new Session(root) })[0]!
  const pull = (m: PaneModel) => {
    const reply = parseFeedReply(feed.handler(feedArgs(m)).text)
    assert.ok(reply !== null)
    return applyReply(m, reply, FIVE_AT.mid)
  }

  const first = pull(emptyModel())
  assert.equal(first.model.state?.swarm.name, 'auth refactor')
  for (const e of events.slice(30)) assert.ok(appendEvent(root, e))
  const second = pull(first.model)
  assert.equal(second.changed, true)

  const state = second.model.state!
  assert.equal(Object.keys(state.links).length, 8)
  const frame = render(state, { ...emptyView(), pulses: second.model.pulses }, FIVE_AT.mid, { columns: 120, rows: 44 })
  const text = [...gridText(frame.top), ...gridText(frame.bottom!)].join('\n')
  for (const name of ['lead', 'architect', 'coder-1', 'coder-2', 'tester', 'reviewer', 'ghost']) assert.ok(text.includes(name), name)
  const totals = swarmTotals(state, FIVE_AT.mid)
  assert.equal(totals.agents, 6)
  assert.ok(text.includes('6 agents'))
  assert.ok(text.includes(`${fmtTokens(totals.tokens)} tok`))
  assert.deepEqual(frame.chips.map(c => c.label), ['lead', 'architect', 'coder-1', 'coder-2', 'tester', 'reviewer'])
})
