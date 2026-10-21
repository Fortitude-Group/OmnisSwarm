/**
 * USD per million tokens. Source: the claude-api skill's model table (cached 2026-10-06) and its
 * prompt-caching reference: cache writes are 1.25x base input (5 minute) and 2x (1 hour), and cache
 * reads vary by model. Update this table when prices change. Nothing else needs to move.
 */

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }

export type Price = {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
  contextWindow: number
  /** A higher rate for prompts over `above` tokens (Haiku 5.5). */
  longContext?: { above: number; input: number; output: number }
}

const price = (input: number, output: number, cacheRead: number, contextWindow: number, longContext?: Price['longContext']): Price => ({
  input,
  output,
  cacheRead,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
  contextWindow,
  ...(longContext !== undefined && { longContext }),
})

const M = 1_000_000

export const PRICES: Readonly<Record<string, Price>> = {
  'claude-fable-5-1': price(10, 50, 0.25, M),
  'claude-mythos-5-1': price(10, 50, 0.25, M),
  'claude-fable-5': price(10, 50, 1, M),
  'claude-opus-5-5': price(4, 20, 0.2, M),
  'claude-opus-5': price(5, 25, 0.5, M),
  'claude-opus-4-8': price(5, 25, 0.5, M),
  'claude-opus-4-7': price(5, 25, 0.5, M),
  'claude-opus-4-6': price(5, 25, 0.5, M),
  'claude-sonnet-5-5': price(2, 10, 0.2, M),
  'claude-sonnet-5': price(2, 10, 0.2, M),
  'claude-sonnet-4-6': price(3, 15, 0.3, M),
  'claude-haiku-5-5': price(0.1, 0.5, 0.01, M, { above: 100_000, input: 0.5, output: 2.5 }),
  'claude-haiku-4-5': price(1, 5, 0.1, 200_000),
}

/** Exact id first, else the longest table id that the model id extends with a dash (dated ids). */
export function priceFor(model: string): Price | null {
  if (Object.hasOwn(PRICES, model)) return PRICES[model] ?? null
  let best: string | null = null
  for (const key of Object.keys(PRICES)) {
    if (model.startsWith(`${key}-`) && (best === null || key.length > best.length)) best = key
  }
  return best === null ? null : (PRICES[best] ?? null)
}

/** Dollars for one call's usage, or null when the model isn't in the table. */
export function costOf(model: string, usage: Usage): number | null {
  const base = priceFor(model)
  if (base === null) return null
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h
  const lc = base.longContext
  const rate = lc !== undefined && prompt > lc.above
    ? { ...base, input: lc.input, output: lc.output, cacheRead: lc.input * 0.1, cacheWrite5m: lc.input * 1.25, cacheWrite1h: lc.input * 2 }
    : base
  return (
    usage.input * rate.input +
    usage.output * rate.output +
    usage.cacheRead * rate.cacheRead +
    usage.cacheWrite5m * rate.cacheWrite5m +
    usage.cacheWrite1h * rate.cacheWrite1h
  ) / M
}
