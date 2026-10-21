/** The Node version check for server start-up. Kept apart from server.ts so a test can import it without starting a server. */

/** A one-line complaint if `version` (like "v22.4.0") is too old to run the server, else null. */
export function nodeVersionProblem(version: string): string | null {
  const m = /^v?(\d+)\.(\d+)/.exec(version)
  const major = m === null ? 0 : Number(m[1])
  const minor = m === null ? 0 : Number(m[2])
  const ok = major >= 24 || (major === 22 && minor >= 18)
  return ok ? null : `omnis-swarm needs Node 24 or newer; found v${version.replace(/^v/, '')}`
}
