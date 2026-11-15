import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOLD_MAX_MS, SpawnHolds, WARM_MS, holdSettingFrom, type HoldOutcome, type Ticket, type Turn } from '../../src/mod/spawn-holds.ts'

const EXPLORE = 'Explore\n'
const PLAN = 'Plan\n'

function ticket(t: Turn): Ticket {
  assert.equal(t.kind, 'hold')
  return t as Ticket
}

/** What a ticket has been told so far (undefined while it waits). */
function told(t: Ticket): { o: HoldOutcome | undefined } {
  const box: { o: HoldOutcome | undefined } = { o: undefined }
  void t.done.then(o => {
    box.o = o
  })
  return box
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test('the setting is on unless it says off', () => {
  assert.equal(holdSettingFrom(undefined), 'on')
  assert.equal(holdSettingFrom('on'), 'on')
  assert.equal(holdSettingFrom('nonsense'), 'on')
  assert.equal(holdSettingFrom('off'), 'off')
})

test('the first of a type leads, the next two are held, and the first answer lets them go', async () => {
  const h = new SpawnHolds()
  assert.deepEqual(h.arrive(EXPLORE, 'Explore', 0), { kind: 'lead' })
  h.started(EXPLORE, 'a1', 10)
  const second = ticket(h.arrive(EXPLORE, 'Explore', 100))
  const third = ticket(h.arrive(EXPLORE, 'Explore', 200))
  assert.equal(second.first, true)
  assert.equal(third.first, false)
  const [s, t] = [told(second), told(third)]
  assert.equal(h.awaited('a1'), true)
  assert.deepEqual(h.answered('a1', 41_100), { role: 'Explore', count: 2, ms: 41_000, why: 'answered' })
  await tick()
  assert.deepEqual([s.o, t.o], ['answered', 'answered'])
  assert.equal(h.awaited('a1'), false)
  // Warm now: another goes straight away, and a second answer ends nothing.
  assert.deepEqual(h.arrive(EXPLORE, 'Explore', 50_000), { kind: 'pass' })
  assert.equal(h.answered('a1', 50_000), null)
})

test('different types and models never hold each other', () => {
  const h = new SpawnHolds()
  assert.equal(h.arrive(EXPLORE, 'Explore', 0).kind, 'lead')
  assert.equal(h.arrive(PLAN, 'Plan', 0).kind, 'lead')
  assert.equal(h.arrive('Explore\nhaiku', 'Explore', 0).kind, 'lead')
  assert.equal(h.arrive(EXPLORE, 'Explore', 0).kind, 'hold')
})

test('a hold lets go at 4 minutes, and later spawns of that type go straight away', async () => {
  const h = new SpawnHolds()
  h.arrive(EXPLORE, 'Explore', 0)
  h.started(EXPLORE, 'a1', 0)
  const held = ticket(h.arrive(EXPLORE, 'Explore', 1000))
  const box = told(held)
  assert.deepEqual(h.expire(1000 + HOLD_MAX_MS - 1), [])
  assert.deepEqual(h.expire(1000 + HOLD_MAX_MS), [{ role: 'Explore', count: 1, ms: HOLD_MAX_MS, why: 'timeout' }])
  await tick()
  assert.equal(box.o, 'timeout')
  assert.equal(h.arrive(EXPLORE, 'Explore', 1000 + HOLD_MAX_MS + 5).kind, 'pass')
})

test('a spawn that arrives after the time is up ends the round itself', async () => {
  const h = new SpawnHolds()
  h.arrive(EXPLORE, 'Explore', 0)
  h.started(EXPLORE, 'a1', 0)
  const box = told(ticket(h.arrive(EXPLORE, 'Explore', 0)))
  const ends: unknown[] = []
  assert.equal(h.arrive(EXPLORE, 'Explore', HOLD_MAX_MS, ends as never).kind, 'pass')
  assert.deepEqual(ends, [{ role: 'Explore', count: 1, ms: HOLD_MAX_MS, why: 'timeout' }])
  await tick()
  assert.equal(box.o, 'timeout')
})

test('a leader that finishes without answering lets its siblings go', async () => {
  const h = new SpawnHolds()
  h.arrive(EXPLORE, 'Explore', 0)
  h.started(EXPLORE, 'a1', 0)
  const box = told(ticket(h.arrive(EXPLORE, 'Explore', 0)))
  assert.deepEqual(h.finished('a1', 12_000), { role: 'Explore', count: 1, ms: 12_000, why: 'failed' })
  await tick()
  assert.equal(box.o, 'failed')
  // Someone else finishing ends nothing.
  assert.equal(h.finished('nobody', 13_000), null)
})

test('a leader whose spawn is refused hands over to the longest-held sibling', async () => {
  const h = new SpawnHolds()
  h.arrive(EXPLORE, 'Explore', 0)
  const first = told(ticket(h.arrive(EXPLORE, 'Explore', 1)))
  const second = told(ticket(h.arrive(EXPLORE, 'Explore', 2)))
  h.started(EXPLORE, null, 3)
  await tick()
  assert.deepEqual([first.o, second.o], ['lead', undefined])
  h.started(EXPLORE, 'a2', 4)
  assert.deepEqual(h.answered('a2', 3002), { role: 'Explore', count: 2, ms: 3001, why: 'answered' })
  await tick()
  assert.equal(second.o, 'answered')
})

test('a refused leader with nobody waiting leaves the type free', () => {
  const h = new SpawnHolds()
  h.arrive(EXPLORE, 'Explore', 0)
  h.started(EXPLORE, null, 1)
  assert.equal(h.arrive(EXPLORE, 'Explore', 2).kind, 'lead')
})

test('a cancelled ticket is not told, and a leader that never reports back is dropped after 4 minutes', async () => {
  const h = new SpawnHolds()
  h.arrive(EXPLORE, 'Explore', 0)
  const held = ticket(h.arrive(EXPLORE, 'Explore', 0))
  const box = told(held)
  held.cancel()
  h.started(EXPLORE, 'a1', 0)
  assert.deepEqual(h.answered('a1', 5000), { role: 'Explore', count: 1, ms: 5000, why: 'answered' })
  await tick()
  assert.equal(box.o, undefined)

  const g = new SpawnHolds()
  g.arrive(PLAN, 'Plan', 0)
  assert.equal(g.arrive(PLAN, 'Plan', HOLD_MAX_MS).kind, 'lead')
})

test('warmth lasts 5 minutes from the latest step, then the next spawn leads again', () => {
  const h = new SpawnHolds()
  h.arrive(EXPLORE, 'Explore', 0)
  h.started(EXPLORE, 'a1', 0)
  h.answered('a1', 1000)
  h.track(EXPLORE, 'a2')
  h.stepped('a2', 200_000)
  assert.equal(h.arrive(EXPLORE, 'Explore', 200_000 + WARM_MS - 1).kind, 'pass')
  assert.equal(h.arrive(EXPLORE, 'Explore', 200_000 + WARM_MS).kind, 'lead')
})
