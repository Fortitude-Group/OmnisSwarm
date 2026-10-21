/** The plugin's one hooks module (hooks/hooks.json names it). Each part registers its own hooks. */
import type { Register } from 'claude-code'
import { registerGuard } from './guard.ts'
import { registerRecorder } from './recorder.ts'

export const register: Register = (on, _options) => {
  registerGuard(on)
  registerRecorder(on)
}
