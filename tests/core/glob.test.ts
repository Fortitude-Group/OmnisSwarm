import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchesAny, validPattern } from '../../src/core/glob.ts'

const m = (pattern: string, rel: string, fold = false) => matchesAny([pattern], rel, fold)

test('src/** matches anything under src, and src/*.ts only one level', () => {
  assert.equal(m('src/**', 'src/a/b.ts'), true)
  assert.equal(m('src/**', 'src/b.ts'), true)
  assert.equal(m('src/*.ts', 'src/a/b.ts'), false)
  assert.equal(m('src/*.ts', 'src/b.ts'), true)
  assert.equal(m('src/**', 'lib/b.ts'), false)
  assert.equal(m('src/**', 'srcs/b.ts'), false)
})

test('a trailing slash means the folder and everything under it', () => {
  assert.equal(m('docs/', 'docs/x/y.md'), true)
  assert.equal(m('docs/', 'docs/x.md'), true)
  assert.equal(m('docs/', 'docsx/y.md'), false)
  assert.equal(m('docs/', 'other/docs/y.md'), false)
})

test('** matches zero or more whole segments', () => {
  assert.equal(m('**/*.test.ts', 'a.test.ts'), true)
  assert.equal(m('**/*.test.ts', 'tests/core/a.test.ts'), true)
  assert.equal(m('**/*.test.ts', 'tests/core/a.ts'), false)
  assert.equal(m('a/**/z.ts', 'a/z.ts'), true)
  assert.equal(m('a/**/z.ts', 'a/b/c/z.ts'), true)
  assert.equal(m('a/**/z.ts', 'a/b/c/y.ts'), false)
  assert.equal(m('**', 'anything/at/all.txt'), true)
  assert.equal(m('**/**/x', 'x'), true)
})

test('? is one character that is not a slash, and * never crosses a slash', () => {
  assert.equal(m('src/?.ts', 'src/a.ts'), true)
  assert.equal(m('src/?.ts', 'src/ab.ts'), false)
  assert.equal(m('src/?.ts', 'src/.ts'), false)
  assert.equal(m('a?b', 'a/b'), false)
  assert.equal(m('a*b', 'a/b'), false)
  assert.equal(m('a*b', 'axxb'), true)
  assert.equal(m('a*b', 'ab'), true)
  assert.equal(m('*', 'file'), true)
  assert.equal(m('*', 'dir/file'), false)
  assert.equal(m('a*b*c', 'aXbYbZc'), true)
  assert.equal(m('a*b*c', 'aXbYbZ'), false)
})

test('a pattern equal to the whole path matches, and a longer or shorter path does not', () => {
  assert.equal(m('src/a/b.ts', 'src/a/b.ts'), true)
  assert.equal(m('src/a/b.ts', 'src/a/b.tsx'), false)
  assert.equal(m('src/a/b.ts', 'src/a'), false)
  assert.equal(m('src/a/b.ts', 'src/a/b.ts/c'), false)
})

test('case folds only when asked', () => {
  assert.equal(m('Src/**', 'src/a.ts', false), false)
  assert.equal(m('Src/**', 'src/a.ts', true), true)
  assert.equal(m('src/*.TS', 'src/a.ts', true), true)
  assert.equal(m('src/a.ts', 'SRC/A.TS', false), false)
})

test('matchesAny is true when any pattern matches, and false for none or no patterns', () => {
  assert.equal(matchesAny(['docs/', 'src/**'], 'src/a.ts', false), true)
  assert.equal(matchesAny(['docs/', 'lib/**'], 'src/a.ts', false), false)
  assert.equal(matchesAny([], 'src/a.ts', false), false)
})

test('a path that climbs out never matches, and stray dots and empty segments are ignored', () => {
  assert.equal(m('**', '../x.ts'), false)
  assert.equal(m('src/**', 'src/../../x.ts'), false)
  assert.equal(m('src/*.ts', './src//a.ts'), true)
  assert.equal(m('**', ''), false)
})

test('a long hostile pattern and path finish quickly', () => {
  const started = Date.now()
  assert.equal(m('*a*a*a*a*a*a*a*a*a*a*a*a*b', 'a'.repeat(5000)), false)
  assert.equal(m('**/**/**/**/**/**/**/**/x', 'a/'.repeat(2000) + 'y'), false)
  assert.ok(Date.now() - started < 2000)
})

test('good patterns are accepted', () => {
  for (const p of ['src/**', 'src/*.ts', 'docs/', 'a b/c.md', 'x@1+2/y_z-1.ts', '**/*.test.ts', '?', 'a'.repeat(200)]) {
    assert.equal(validPattern(p), null, p)
  }
})

test('bad patterns are refused with a reason', () => {
  const bad = [
    '', 'a'.repeat(201), '/etc/passwd', '/', 'C:/x', 'c:x', '..', '../x', 'a/../b', 'a/..', 'a\\b', '\\\\server\\share',
    'a;b', 'a$b', 'a"b', "a'b", 'a`b', 'a|b', 'a<b', 'a:b', 'a\nb', 'a\u0000b', 'caf\u00e9', 'a//b', './a', 'a/./b', 'a,b', 'a{b}', 'a[b]', 'a(b)', 'a#b', 'a~b', 'a!b', 'a%b', 'a^b', 'a&b', 'a=b',
  ]
  for (const p of bad) {
    const why = validPattern(p)
    assert.equal(typeof why, 'string', JSON.stringify(p))
    assert.ok(why!.length > 0 && why!.length < 120, JSON.stringify(p))
  }
})

test('three dots and dotfiles are fine, only a bare .. segment is refused', () => {
  assert.equal(validPattern('...'), null)
  assert.equal(validPattern('a/..b'), null)
  assert.equal(validPattern('.github/**'), null)
})
