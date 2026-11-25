export type ToolValidationConfig = {
  filePatternTools: readonly string[]
  bashPrefixTools: readonly string[]
  customValidation: Record<
    string,
    (ruleContent: string) => {
      valid: boolean
      error?: string
      suggestion?: string
      examples?: string[]
    }
  >
}

export const TOOL_VALIDATION_CONFIG: ToolValidationConfig = {
  filePatternTools: [
    'Read',
    'Write',
    'Edit',
    'Glob',
    'NotebookRead',
    'NotebookEdit',
  ],
  bashPrefixTools: ['Bash'],
  customValidation: {
    WebSearch: (ruleContent: string) => {
      if (ruleContent.includes('*') || ruleContent.includes('?')) {
        return {
          valid: false,
          error: 'WebSearch rules do not support wildcards (* or ?)',
          suggestion: 'Use an exact search query or omit the pattern',
          examples: ['WebSearch', 'WebSearch(typescript generics)'],
        }
      }
      return { valid: true }
    },
    WebFetch: (ruleContent: string) => {
      if (ruleContent.includes('://') || ruleContent.startsWith('http')) {
        return {
          valid: false,
          error: 'WebFetch rules must use the "domain:" prefix instead of URLs',
          suggestion: 'Use domain:<hostname> format',
          examples: ['WebFetch(domain:docs.anthropic.com)'],
        }
      }
      if (!ruleContent.startsWith('domain:')) {
        return {
          valid: false,
          error: 'WebFetch rules must start with "domain:"',
          suggestion: 'Prefix the hostname with "domain:"',
          examples: ['WebFetch(domain:example.com)'],
        }
      }
      return { valid: true }
    },
  },
}

export function isFilePatternTool(toolName: string): boolean {
  return TOOL_VALIDATION_CONFIG.filePatternTools.includes(toolName)
}

export function isBashPrefixTool(toolName: string): boolean {
  return TOOL_VALIDATION_CONFIG.bashPrefixTools.includes(toolName)
}

export function getCustomValidation(
  toolName: string,
): ToolValidationConfig['customValidation'][string] | undefined {
  return TOOL_VALIDATION_CONFIG.customValidation[toolName]
}
