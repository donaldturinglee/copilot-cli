export type OutputStyleConfig = {
  name: string
  description: string
  prompt: string
  keepCodingInstructions?: boolean
  source: 'builtin' | 'user' | 'project'
}

export const BUILTIN_OUTPUT_STYLES: Readonly<Record<string, OutputStyleConfig>> = {
  default: {
    name: 'default',
    description: 'Concise engineering assistant optimized for direct software tasks',
    prompt: '',
    keepCodingInstructions: true,
    source: 'builtin',
  },
  explanatory: {
    name: 'explanatory',
    description: 'Provides architectural rationale and trade-off insights alongside code changes',
    prompt:
      'Explain key architectural decisions, trade-offs, and invariants concisely as you work.',
    keepCodingInstructions: true,
    source: 'builtin',
  },
  learning: {
    name: 'learning',
    description: 'Collaborative learning mode that guides the user through concepts step by step',
    prompt:
      'Adopt a collaborative teaching style: explain underlying concepts clearly and highlight opportunities for the user to verify or extend each step.',
    keepCodingInstructions: true,
    source: 'builtin',
  },
}
