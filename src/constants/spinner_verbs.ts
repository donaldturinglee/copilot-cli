export const DEFAULT_SPINNER_VERBS = [
  'Thinking',
  'Analyzing',
  'Reasoning',
  'Exploring',
  'Inspecting',
  'Synthesizing',
  'Crafting',
  'Compiling',
  'Evaluating',
  'Planning',
  'Investigating',
  'Working',
] as const

export function getSpinnerVerbs(customVerbs?: readonly string[]): readonly string[] {
  if (customVerbs && customVerbs.length > 0) {
    return customVerbs
  }
  return DEFAULT_SPINNER_VERBS
}
