import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectCommand, gateSettings } from '../../src/mcp/gate/detect.ts'
import { tmpRoot } from '../helpers.ts'

const put = (dir: string, rel: string, body = '') => {
  mkdirSync(join(dir, rel, '..'), { recursive: true })
  writeFileSync(join(dir, rel), body)
}
const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: 'x', scripts })

test('gateSettings: defaults are block, detect and 10 minutes', () => {
  assert.deepEqual(gateSettings({}), { mode: 'block', command: '', minutes: 10 })
})

test('gateSettings: the mode is block, warn or off; anything else is block', () => {
  const mode = (v: string) => gateSettings({ OMNIS_VERIFY_GATE: v }).mode
  assert.equal(mode('warn'), 'warn')
  assert.equal(mode('off'), 'off')
  assert.equal(mode(' OFF '), 'off')
  assert.equal(mode('block'), 'block')
  assert.equal(mode('nope'), 'block')
  assert.equal(mode(''), 'block')
  assert.equal(mode('${user_config.verifyGate}'), 'block')
})

test('gateSettings: the command is trimmed, and blank or unexpanded means detect', () => {
  assert.equal(gateSettings({ OMNIS_GATE_COMMAND: '  npm run ci  ' }).command, 'npm run ci')
  assert.equal(gateSettings({ OMNIS_GATE_COMMAND: '   ' }).command, '')
  assert.equal(gateSettings({ OMNIS_GATE_COMMAND: '${user_config.gateCommand}' }).command, '')
})

test('gateSettings: minutes are clamped to 1..60 and non-numbers are 10', () => {
  const m = (v: string) => gateSettings({ OMNIS_GATE_MINUTES: v }).minutes
  assert.equal(m('5'), 5)
  assert.equal(m('0'), 1)
  assert.equal(m('-3'), 1)
  assert.equal(m('600'), 60)
  assert.equal(m('abc'), 10)
  assert.equal(m(''), 10)
  assert.equal(m('Infinity'), 10)
  assert.equal(m('${user_config.gateMinutes}'), 10)
  assert.equal(m('2.6'), 3)
})

test('detectCommand: nothing found is null', () => {
  assert.equal(detectCommand(tmpRoot()), null)
})

test('detectCommand: the detection order is ps1, sh, check, test, then a solution', () => {
  const dir = tmpRoot()
  put(dir, 'App.sln')
  assert.equal(detectCommand(dir), 'dotnet test App.sln')
  put(dir, 'package.json', pkg({ test: 'node --test' }))
  assert.equal(detectCommand(dir), 'npm test')
  put(dir, 'package.json', pkg({ test: 'node --test', check: 'tsc && npm test' }))
  assert.equal(detectCommand(dir), 'npm run check')
  put(dir, 'scripts/build-test.sh', 'exit 0')
  assert.equal(detectCommand(dir), 'bash scripts/build-test.sh')
  put(dir, 'scripts/build-test.ps1', 'exit 0')
  assert.equal(detectCommand(dir), 'pwsh -NoProfile -File scripts/build-test.ps1')
})

test("detectCommand: npm's placeholder test script doesn't count", () => {
  const dir = tmpRoot()
  put(dir, 'package.json', pkg({ test: 'echo "Error: no test specified" && exit 1' }))
  assert.equal(detectCommand(dir), null)
})

test('detectCommand: a package.json that is not JSON, or has no scripts, is skipped', () => {
  const dir = tmpRoot()
  put(dir, 'package.json', '{ not json')
  assert.equal(detectCommand(dir), null)
  put(dir, 'package.json', JSON.stringify({ scripts: { check: 42 } }))
  assert.equal(detectCommand(dir), null)
  put(dir, 'package.json', JSON.stringify({ scripts: ['test'] }))
  assert.equal(detectCommand(dir), null)
})

test('detectCommand: one .slnx wins over .sln, two .sln files mean none', () => {
  const dir = tmpRoot()
  put(dir, 'A.sln')
  put(dir, 'B.sln')
  assert.equal(detectCommand(dir), null)
  put(dir, 'C.slnx')
  assert.equal(detectCommand(dir), 'dotnet test C.slnx')
  put(dir, 'D.slnx')
  assert.equal(detectCommand(dir), null)
})

test('detectCommand: a solution name with a space is quoted; one with shell characters is not used', () => {
  const spaced = tmpRoot()
  put(spaced, 'My App.sln')
  assert.equal(detectCommand(spaced), 'dotnet test "My App.sln"')
  const odd = tmpRoot()
  put(odd, 'a&b.sln')
  assert.equal(detectCommand(odd), null)
})

test('detectCommand: a folder named like a marker is not a marker', () => {
  const dir = tmpRoot()
  mkdirSync(join(dir, 'scripts', 'build-test.sh'), { recursive: true })
  mkdirSync(join(dir, 'package.json'))
  assert.equal(detectCommand(dir), null)
})

test('detectGate names the kind, the defining file and its content', async () => {
  const { detectGate } = await import('../../src/mcp/gate/detect.ts')
  const dir = tmpRoot()
  put(dir, 'App.sln')
  assert.deepEqual(detectGate(dir), { command: 'dotnet test App.sln', kind: 'dotnet', file: null, content: 'dotnet test App.sln' })
  put(dir, 'package.json', pkg({ test: 'node --test' }))
  assert.deepEqual(detectGate(dir), { command: 'npm test', kind: 'test', file: 'package.json', content: 'node --test' })
  put(dir, 'package.json', pkg({ test: 'node --test', check: 'tsc' }))
  assert.deepEqual(detectGate(dir), { command: 'npm run check', kind: 'check', file: 'package.json', content: 'tsc' })
  put(dir, 'scripts/build-test.sh', 'exit 0\n')
  assert.deepEqual(detectGate(dir), { command: 'bash scripts/build-test.sh', kind: 'sh', file: 'scripts/build-test.sh', content: Buffer.from('exit 0\n') })
  put(dir, 'scripts/build-test.ps1', 'exit 0')
  const ps1 = detectGate(dir)
  assert.equal(ps1?.kind, 'ps1')
  assert.equal(ps1?.file, 'scripts/build-test.ps1')
  assert.deepEqual(ps1?.content, Buffer.from('exit 0'))
  assert.equal(detectGate(tmpRoot()), null)
})
