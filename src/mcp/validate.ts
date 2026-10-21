/** Input checks at the MCP boundary. A failure throws InputError, which the protocol turns into an error result. */
import type { Args } from './protocol.ts'

export class InputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InputError'
  }
}

export function reqString(args: Args, key: string, max: number, pattern?: RegExp): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new InputError(`${key} must be a non-empty string of at most ${max} characters`)
  }
  if (pattern !== undefined && !pattern.test(value)) throw new InputError(`${key} contains characters that aren't allowed`)
  return value
}

export function optString(args: Args, key: string, max: number, pattern?: RegExp): string | undefined {
  return args[key] === undefined || args[key] === null ? undefined : reqString(args, key, max, pattern)
}

export function reqEnum<T extends string>(args: Args, key: string, values: readonly T[]): T {
  const value = args[key]
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new InputError(`${key} must be one of: ${values.join(', ')}`)
  }
  return value as T
}

export function optStringList(args: Args, key: string, maxItems: number, maxLen: number, pattern?: RegExp): string[] | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > maxItems) throw new InputError(`${key} must be a list of at most ${maxItems} items`)
  for (const item of value) {
    if (typeof item !== 'string' || item === '' || item.length > maxLen || (pattern !== undefined && !pattern.test(item))) {
      throw new InputError(`${key} has an item that isn't allowed`)
    }
  }
  return value as string[]
}
