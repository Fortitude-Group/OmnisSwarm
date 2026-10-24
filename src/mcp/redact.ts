/** Secret-shaped text is blanked before text from elsewhere reaches the log or a reply. The patterns live in src/core/secrets.ts so the handoff note can use them. */
import { SECRETISH, redactSecrets } from '../core/secrets.ts'

export { SECRETISH }

export const redact = (text: string): string => redactSecrets(text)
