import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Outbox } from '../../src/mod/outbox.ts'

test('takes slots up to the limit, then drops and counts', () => {
  const box = new Outbox(2)
  assert.equal(box.take(), 0)
  assert.equal(box.take(), 0)
  assert.equal(box.take(), null)
  assert.equal(box.take(), null)
  assert.equal(box.inFlight, 2)
  assert.equal(box.dropped, 2)
})

test('the drop count rides on the next call that gets a slot, and only that one', () => {
  const box = new Outbox(1)
  box.take()
  box.take()
  box.settle(true, 0)
  assert.equal(box.take(), 1)
  assert.equal(box.dropped, 0)
  box.settle(true, 1)
  assert.equal(box.take(), 0)
})

test('a failed call counts itself and what it carried', () => {
  const box = new Outbox(4)
  box.lose(2)
  const carried = box.take()
  assert.equal(carried, 2)
  box.settle(false, carried!)
  assert.equal(box.dropped, 3)
  assert.equal(box.inFlight, 0)
})

test('defaults to 64 in flight and never goes below zero', () => {
  const box = new Outbox()
  for (let i = 0; i < 64; i++) assert.equal(box.take(), 0)
  assert.equal(box.take(), null)
  const fresh = new Outbox()
  fresh.settle(true, 0)
  assert.equal(fresh.inFlight, 0)
})
