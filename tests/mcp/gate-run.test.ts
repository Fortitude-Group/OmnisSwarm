import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { LOG_CAP, TAIL_CHARS, TAIL_LINES, runGate, type RunOptions } from '../../src/mcp/gate/run.ts'
import { InputError } from '../../src/mcp/validate.ts'
import { tmpRoot } from '../helpers.ts'

/** A shell command that runs `code` with this node. The code must not hold double quotes or `$`. */
const node = (code: string) => `"${process.execPath}" -e "${code}"`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
/** Waits up to `ms` for `pid` to be gone. */
async function gone(pid: number, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (!alive(pid)) return true
    await sleep(100)
  }
  return !alive(pid)
}
const setup = (over: Partial<RunOptions> = {}): RunOptions => {
  const dir = tmpRoot()
  mkdirSync(join(dir, 'logs'))
  return { command: node('0'), cwd: dir, logFile: join(dir, 'logs', 'g.log'), limitMs: 20_000, ...over }
}
/** Starts a grandchild that sleeps 30 s, prints its PID, then sleeps itself. */
const SPAWNS_GRANDCHILD = node("const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore'});console.log('GRANDCHILD '+c.pid);setTimeout(()=>{},30000)")
const grandchildPid = (log: string): number => {
  const m = /GRANDCHILD (\d+)/.exec(readFileSync(log, 'utf8'))
  assert.ok(m, 'the grandchild printed its pid')
  return Number(m[1])
}

test('exit 0 passes, and output goes to the log', async () => {
  const opts = setup({ command: node("console.log('hello from the gate')") })
  const out = await runGate(opts)
  assert.equal(out.result, 'passed')
  assert.equal(out.exit, 0)
  assert.ok(out.ms >= 0)
  assert.match(readFileSync(opts.logFile, 'utf8'), /hello from the gate/)
  assert.equal(out.tail, 'hello from the gate')
})

test('exit 3 fails with the code, and stderr is in the log and tail', async () => {
  const opts = setup({ command: node("console.error('broken test');process.exit(3)") })
  const out = await runGate(opts)
  assert.equal(out.result, 'failed')
  assert.equal(out.exit, 3)
  assert.match(out.tail, /broken test/)
})

test('stdin is not open to the gate', async () => {
  const opts = setup({ command: node("process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"), limitMs: 10_000 })
  const out = await runGate(opts)
  assert.equal(out.result, 'passed')
})

test('past the time limit the whole tree is killed, grandchild included', async () => {
  const opts = setup({ command: SPAWNS_GRANDCHILD, limitMs: 1500 })
  const out = await runGate(opts)
  assert.equal(out.result, 'timeout')
  assert.equal(out.exit, undefined)
  assert.ok(out.ms >= 1400 && out.ms < 15_000, `took ${out.ms} ms`)
  assert.ok(await gone(grandchildPid(opts.logFile)), 'the grandchild is gone')
})

test('an abort kills the tree and answers cancelled', async () => {
  const controller = new AbortController()
  const opts = setup({ command: SPAWNS_GRANDCHILD, signal: controller.signal })
  const running = runGate(opts)
  await sleep(1200)
  controller.abort()
  const out = await running
  assert.equal(out.result, 'cancelled')
  assert.ok(await gone(grandchildPid(opts.logFile)), 'the grandchild is gone')
})

test('an already aborted signal runs nothing', async () => {
  const controller = new AbortController()
  controller.abort()
  const opts = setup({ command: node("require('fs').writeFileSync('ran','x')"), signal: controller.signal })
  const out = await runGate(opts)
  assert.equal(out.result, 'cancelled')
  assert.throws(() => statSync(join(opts.cwd, 'ran')))
})

test('a run directory that does not exist is a could-not-start error', async () => {
  const opts = setup()
  const out = await runGate({ ...opts, cwd: join(opts.cwd, 'missing') })
  assert.equal(out.result, 'error')
  assert.ok(typeof out.error === 'string' && out.error.length > 0)
})

test('3 MiB of output: the log keeps its head and tail under the cap, with a marker', async () => {
  const opts = setup({ command: node("let s='';for(let i=0;i<40000;i++){s+='line '+i+' '+'.'.repeat(70)+'\\n'}process.stdout.write(s)") })
  const out = await runGate(opts)
  assert.equal(out.result, 'passed')
  const log = readFileSync(opts.logFile, 'utf8')
  assert.ok(Buffer.byteLength(log) <= LOG_CAP, `log is ${Buffer.byteLength(log)} bytes`)
  assert.ok(Buffer.byteLength(log) > LOG_CAP - 4096)
  assert.ok(log.startsWith('line 0 '))
  assert.match(log, /\n\[omnis: \d+ bytes dropped from the middle of this log\]\n/)
  assert.ok(log.trimEnd().endsWith(`line 39999 ${'.'.repeat(70)}`))
  const lines = out.tail.split('\n')
  assert.equal(lines.length, TAIL_LINES)
  assert.ok(out.tail.length <= TAIL_CHARS)
  assert.equal(lines.at(-1), `line 39999 ${'.'.repeat(70)}`)
})

test('output under the cap is kept whole, even past the first half', async () => {
  const opts = setup({ command: node("let s='';for(let i=0;i<18000;i++){s+='row '+i+' '+'.'.repeat(70)+'\\n'}process.stdout.write(s)") })
  const out = await runGate(opts)
  const log = readFileSync(opts.logFile, 'utf8')
  assert.equal(out.result, 'passed')
  assert.doesNotMatch(log, /bytes dropped/)
  assert.equal(log.split('\n').filter(Boolean).length, 18000)
})

test('the tail is at most 4,000 characters and token-shaped runs are blanked', async () => {
  const opts = setup({ command: node("console.log('token ghp_abcdefghijklmnop1234');console.log('x'.repeat(5000).split('').join(' '))") })
  const out = await runGate(opts)
  assert.ok(out.tail.length <= TAIL_CHARS)
  const short = setup({ command: node("console.log('token ghp_abcdefghijklmnop1234 end')") })
  const out2 = await runGate(short)
  assert.equal(out2.tail, 'token [redacted] end')
  assert.match(readFileSync(short.logFile, 'utf8'), /ghp_abcdefghijklmnop1234/, 'the log itself is not redacted')
})

test('a second gate in the same directory is refused while one runs', async () => {
  const opts = setup({ command: node('setTimeout(()=>{},1500)') })
  const first = runGate(opts)
  assert.throws(() => runGate({ ...opts, logFile: `${opts.logFile}.2` }), (err: unknown) =>
    err instanceof InputError && err.message === `A gate is already running in ${opts.cwd}. Wait for it, then try again.`)
  assert.equal((await first).result, 'passed')
  assert.equal((await runGate({ ...opts, command: node('0') })).result, 'passed', 'free again once it ends')
})

test('a fourth gate anywhere is refused while three run', async () => {
  const runs = [setup(), setup(), setup()].map(o => runGate({ ...o, command: node('setTimeout(()=>{},1500)') }))
  assert.throws(() => runGate(setup()), (err: unknown) => err instanceof InputError && err.message === 'Three gates are already running.')
  for (const r of runs) assert.equal((await r).result, 'passed')
})

test('a background child holding the output open does not hold the gate past its exit', async () => {
  const opts = setup({ command: node("const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'inherit'});console.log('GRANDCHILD '+c.pid);c.unref()"), limitMs: 20_000 })
  const out = await runGate(opts)
  const pid = grandchildPid(opts.logFile)
  try {
    assert.equal(out.result, 'passed')
    assert.ok(out.ms < 10_000, `took ${out.ms} ms`)
  } finally {
    if (alive(pid)) process.kill(pid) // ours: started by this test's command
  }
})

test('the gate settings are not passed on to the gate command', async () => {
  const keys = ['OMNIS_VERIFY_GATE', 'OMNIS_GATE_COMMAND', 'OMNIS_GATE_MINUTES'] as const
  const saved = keys.map(k => process.env[k])
  process.env.OMNIS_VERIFY_GATE = 'warn'
  process.env.OMNIS_GATE_COMMAND = 'npm run check'
  process.env.OMNIS_GATE_MINUTES = '5'
  process.env.OMNIS_GATE_TEST_KEPT = 'kept'
  try {
    const opts = setup({ command: node("console.log(['OMNIS_VERIFY_GATE','OMNIS_GATE_COMMAND','OMNIS_GATE_MINUTES','OMNIS_GATE_TEST_KEPT'].map(k=>k+'='+(process.env[k]??'unset')).join(' '))") })
    const out = await runGate(opts)
    assert.equal(out.tail, 'OMNIS_VERIFY_GATE=unset OMNIS_GATE_COMMAND=unset OMNIS_GATE_MINUTES=unset OMNIS_GATE_TEST_KEPT=kept')
  } finally {
    keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i] })
    delete process.env.OMNIS_GATE_TEST_KEPT
  }
})
