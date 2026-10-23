/** The plugin's one hooks module (hooks/hooks.json names it). Each part registers its own hooks. */
import type { Register } from 'claude-code'
import { guardObserver, registerBudgetGuard } from './budget-guard.ts'
import { registerGuard } from './guard.ts'
import { registerPane } from './pane.ts'
import { registerRecorder } from './recorder.ts'
import { registerRunReport } from './run-report.ts'

export const register: Register = (on, options) => {
  registerGuard(on)
  registerRecorder(on, guardObserver)
  registerBudgetGuard(on, options)
  registerPane(on, options)
  registerRunReport(on)
}
