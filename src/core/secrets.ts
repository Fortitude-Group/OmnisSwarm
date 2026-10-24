/** Secret-shaped text, blanked before it reaches the log, a memory preview or a handoff note. Pure and mod-safe. */

/** Token-shaped runs. The recorder keeps a copy (src/mod/record-events.ts); a test keeps them equal. */
export const SECRETISH = /(ghp_|gho_|github_pat_|sk-|sk_live_|xox[bap]-|AKIA)[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.-]+|[A-Za-z0-9+/=_-]{32,}/g
/** scheme://user:SECRET@host keeps the user and blanks the password. */
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/@:]+:)[^\s/@]+@/gi
/** Authorization: Bearer|Basic SECRET. */
const AUTH_HEADER = /(\bauthorization\s*[=:]\s*(?:bearer|basic)\s+)[^\s"',;]+/gi
/** A secret-sounding key, then = or :, then its value. Only names that sound secret, so exit=1 and count=3 stay. */
const SECRET_PAIR = /(\b[\w-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey)[\w-]*\s*[=:]\s*)[^\s&"',;]+/gi

/** Everything but the catch-all long run: for text that holds real paths, where 32 plain characters in a row are not a secret. */
export const redactKnown = (text: string): string =>
  text
    .replace(URL_USERINFO, '$1[redacted]@')
    .replace(AUTH_HEADER, '$1[redacted]')
    .replace(SECRET_PAIR, '$1[redacted]')
    .replace(/(ghp_|gho_|github_pat_|sk-|sk_live_|xox[bap]-|AKIA)[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.-]+/g, '[redacted]')

export const redactSecrets = (text: string): string => redactKnown(text).replace(SECRETISH, '[redacted]')
