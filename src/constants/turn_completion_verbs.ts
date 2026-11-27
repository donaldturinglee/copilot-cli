export const TURN_COMPLETION_VERBS = [
  'Completed',
  'Finished',
  'Done',
  'Baked',
  'Crafted',
  'Worked',
  'Cogitated',
  'Brewed',
] as const

export function pickTurnCompletionVerb(seed?: number): string {
  const idx =
    seed !== undefined
      ? Math.abs(Math.floor(seed)) % TURN_COMPLETION_VERBS.length
      : Math.floor(Math.random() * TURN_COMPLETION_VERBS.length)
  return TURN_COMPLETION_VERBS[idx] ?? 'Completed'
}
