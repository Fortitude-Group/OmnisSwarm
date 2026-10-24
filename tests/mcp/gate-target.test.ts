import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectGate } from '../../src/mcp/gate/detect.ts'
import { differsFromRoot, digestOf, gateTarget } from '../../src/mcp/gate/target.ts'
import { tmpRoot } from '../helpers.ts'

const sha = (x: string | Uint8Array) => createHash('sha256').update(x).digest('hex')
const put = (dir: string, rel: string, body: string) => {
  mkdirSync(join(dir, rel, '..'), { recursive: true })
  writeFileSync(join(dir, rel), body)
}
const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: 'x', scripts })
/** A project and one worktree of it, linked both ways as git does. */
function project() {
  const root = tmpRoot()
  const wt = tmpRoot()
  mkdirSync(join(root, '.git', 'worktrees', 'w1'), { recursive: true })
  writeFileSync(join(root, '.git', 'worktrees', 'w1', 'gitdir'), `${join(wt, '.git')}\n`)
  writeFileSync(join(root, '.git', 'worktrees', 'w1', 'HEAD'), 'ref: refs/heads/w1\n')
  writeFileSync(join(wt, '.git'), `gitdir: ${join(root, '.git', 'worktrees', 'w1')}\n`)
  return { root, wt: realpathSync.native(wt) }
}
const differs = (root: string, dir: string) => differsFromRoot(root, dir, detectGate(dir))

test('the digest is the SHA-256 of what defines the gate', () => {
  const { root } = project()
  assert.equal(gateTarget(root, null, undefined, 'npm run ci').digest, sha('npm run ci'))
  put(root, 'App.sln', '')
  assert.equal(gateTarget(root, null, undefined, '').digest, sha('dotnet test App.sln'))
  put(root, 'package.json', pkg({ test: 'node --test', check: 'tsc -p .' }))
  assert.equal(gateTarget(root, null, undefined, '').digest, sha('tsc -p .'))
  put(root, 'scripts/build-test.sh', 'echo ok\n')
  assert.deepEqual(gateTarget(root, null, undefined, ''), {
    dir: realpathSync.native(root), command: 'bash scripts/build-test.sh', digest: sha(Buffer.from('echo ok\n')), detected: detectGate(root),
  })
  assert.equal(digestOf('a'), sha('a'))
})

test('no gate: no command and no digest', () => {
  assert.deepEqual(gateTarget(tmpRoot(), null, undefined, '').command, null)
  assert.deepEqual(gateTarget(tmpRoot(), null, undefined, '').digest, null)
})

test('in the project root itself, or with the gateCommand setting, there is nothing to compare', () => {
  const { root, wt } = project()
  put(root, 'scripts/build-test.sh', 'real tests\n')
  assert.equal(differs(root, realpathSync.native(root)), null)
  put(wt, 'scripts/build-test.sh', 'exit 0\n')
  assert.equal(differsFromRoot(root, wt, null), null)
})

test('a build-test.ps1 or .sh must match the root copy byte for byte', () => {
  for (const file of ['scripts/build-test.ps1', 'scripts/build-test.sh']) {
    const { root, wt } = project()
    put(root, file, 'run the tests\r\n')
    put(wt, file, 'run the tests\r\n')
    assert.equal(differs(root, wt), null, file)
    put(wt, file, 'run the tests\n')
    assert.equal(differs(root, wt), file, file)
  }
})

test('package.json: only the scripts entry used is compared', () => {
  for (const entry of ['check', 'test']) {
    const { root, wt } = project()
    put(root, 'package.json', pkg({ [entry]: 'node --test', build: 'tsc' }))
    put(wt, 'package.json', pkg({ [entry]: 'node --test', build: 'tsc -w', lint: 'x' }))
    assert.equal(differs(root, wt), null, entry)
    put(wt, 'package.json', pkg({ [entry]: 'node -e 0', build: 'tsc' }))
    assert.equal(differs(root, wt), 'package.json', entry)
  }
})

test('dotnet: nothing to compare', () => {
  const { root, wt } = project()
  put(root, 'App.sln', 'a')
  put(wt, 'App.sln', 'b')
  assert.equal(differs(root, wt), null)
})

test('a gate the worktree dropped or swapped for another kind differs', () => {
  const { root, wt } = project()
  put(root, 'scripts/build-test.sh', 'real tests\n')
  put(wt, 'package.json', pkg({ test: 'exit 0' }))
  assert.equal(differs(root, wt), 'package.json')
  const p2 = project()
  put(p2.root, 'scripts/build-test.ps1', 'real tests')
  put(p2.wt, 'App.sln', '')
  assert.equal(differs(p2.root, p2.wt), 'scripts/build-test.ps1')
})

test('a root with no gate has nothing to compare against', () => {
  const { root, wt } = project()
  put(wt, 'scripts/build-test.sh', 'new tests\n')
  assert.equal(differs(root, wt), null)
})
