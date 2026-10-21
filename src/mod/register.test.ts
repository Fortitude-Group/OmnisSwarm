import { expect, test } from 'claude-code/testing'

test('the mod loads and hands session.start through unchanged', async ($, on) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const result = await $.session.start({ cwd: '/project', surface: null, isInteractive: false })
  expect(result.cwd).toBe('/project')
})
