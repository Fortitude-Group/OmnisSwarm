/**
 * Every way a turn can end, for the turn.complete hooks that act when an agent finishes. They need a matcher because the
 * recorder already holds the one unmatched turn.complete hook, and this one takes every reason.
 */
import type { TurnCompleteReason } from 'claude-code'

export const TURN_ENDS = ['answer', 'aborted', 'refusal', 'error'] as const satisfies readonly TurnCompleteReason[]

/** Fails the typecheck when TurnCompleteReason gains a reason TURN_ENDS leaves out. */
type None<T extends never> = T
export type TurnEndsCovered = None<Exclude<TurnCompleteReason, (typeof TURN_ENDS)[number]>>
