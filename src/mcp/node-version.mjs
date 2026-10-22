// Plain JavaScript on purpose: start.mjs imports this before anything TypeScript loads, so it must parse on any Node.

/** A one-line complaint if `version` (like "v22.4.0") can't run TypeScript files directly, else null. */
export function nodeVersionProblem(version) {
  const m = /^v?(\d+)\.(\d+)/.exec(version)
  const major = m === null ? 0 : Number(m[1])
  const minor = m === null ? 0 : Number(m[2])
  const ok = major >= 24 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18)
  return ok ? null : `omnis-swarm needs Node 22.18 or newer (24 recommended); found v${version.replace(/^v/, '')}`
}
