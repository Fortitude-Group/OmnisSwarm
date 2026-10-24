/** Token-shaped runs are blanked before text from elsewhere reaches the log or a reply. The recorder keeps a copy (record-events.ts); a test keeps them equal. */
export const SECRETISH = /(ghp_|gho_|github_pat_|sk-|sk_live_|xox[bap]-|AKIA)[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.-]+|[A-Za-z0-9+/=_-]{32,}/g

export const redact = (text: string): string => text.replace(SECRETISH, '[redacted]')
