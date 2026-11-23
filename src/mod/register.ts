/** The plugin's one hooks module (hooks/hooks.json names it). Each part registers its own hooks. */
import type { Register } from 'claude-code'
import { guardObserver, registerBudgetGuard } from './budget-guard.ts'
import { registerClashGuard } from './clash-guard.ts'
import { registerFenceGuard } from './fence-guard.ts'
import { registerGateGuard } from './gate-guard.ts'
import { registerGuard } from './guard.ts'
import { registerModelDefault } from './model-default.ts'
import { registerPane } from './pane.ts'
import { registerReadyRelay } from './ready-relay.ts'
import { registerRecorder } from './recorder.ts'
import { registerRunReport } from './run-report.ts'
import { registerSpawnHold } from './spawn-hold.ts'
import { registerStuckGuard } from './stuck-guard.ts'

export const register: Register = (on, options) => {
  registerGuard(on)
  registerGateGuard(on)
  registerReadyRelay(on)
  registerRecorder(on, guardObserver)
  registerBudgetGuard(on, options)
  registerFenceGuard(on, options)
  registerClashGuard(on, options)
  registerStuckGuard(on)
  // First outermost: the hold beneath groups on the model this fills in.
  registerModelDefault(on, options)
  registerSpawnHold(on, options)
  registerPane(on, options)
  registerRunReport(on)
}
