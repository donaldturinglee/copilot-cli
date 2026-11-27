export type ContextSuggestion = {
  id: string
  label: string
  insertText: string
  description: string
}

const DEFAULT_SUGGESTIONS: readonly ContextSuggestion[] = [
  {
    id: 'ctx-explain',
    label: 'Explain this codebase',
    insertText: 'Explain the architecture of this codebase',
    description: 'Overview of project structure and entrypoints',
  },
  {
    id: 'ctx-tests',
    label: 'Run tests and fix failures',
    insertText: 'Run the test suite and help diagnose any failures',
    description: 'Execute project tests',
  },
  {
    id: 'ctx-review',
    label: 'Review recent changes',
    insertText: '/review',
    description: 'Inspect git diff and suggest improvements',
  },
]

export function getContextSuggestions(
  query: string,
  customSuggestions?: readonly ContextSuggestion[],
): ContextSuggestion[] {
  const pool = customSuggestions ?? DEFAULT_SUGGESTIONS
  const q = query.trim().toLowerCase()
  if (!q) return [...pool]
  return pool.filter(
    s =>
      s.label.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q),
  )
}
