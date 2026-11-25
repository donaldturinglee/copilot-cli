const DOCS_BASE_URL = 'https://code.claude.com/docs/en'

export type ValidationTip = {
  suggestion?: string
  docLink?: string
}

export type TipContext = {
  path: string
  code: string
  expected?: string
  received?: string
  enumValues?: string[]
  keys?: string[]
}

type TipMatcher = {
  matches: (context: TipContext) => boolean
  tip: (context: TipContext) => ValidationTip
}

const TIP_MATCHERS: readonly TipMatcher[] = [
  {
    matches: ctx => ctx.path === 'permissions.defaultMode',
    tip: () => ({
      suggestion:
        'Use one of: "default", "acceptEdits", "plan", "dontAsk", or "bypassPermissions"',
      docLink: `${DOCS_BASE_URL}/settings#permission-settings`,
    }),
  },
  {
    matches: ctx => ctx.path === 'apiKeyHelper',
    tip: () => ({
      suggestion:
        'Provide a shell command string that prints an API key to stdout',
      docLink: `${DOCS_BASE_URL}/settings#available-settings`,
    }),
  },
  {
    matches: ctx => ctx.path === 'cleanupPeriodDays',
    tip: () => ({
      suggestion:
        'Provide a non-negative integer number of days (e.g., 30; 0 disables cleanup)',
      docLink: `${DOCS_BASE_URL}/settings#available-settings`,
    }),
  },
  {
    matches: ctx => ctx.path.startsWith('env.'),
    tip: () => ({
      suggestion: 'Environment variable values must be strings',
      docLink: `${DOCS_BASE_URL}/settings#environment-variables`,
    }),
  },
  {
    matches: ctx =>
      ctx.path.startsWith('permissions.allow') ||
      ctx.path.startsWith('permissions.deny') ||
      ctx.path.startsWith('permissions.ask'),
    tip: () => ({
      suggestion:
        'Use tool permission rules like "Bash(git status)", "Read(src/**)", or "WebFetch(domain:example.com)"',
      docLink: `${DOCS_BASE_URL}/settings#permission-settings`,
    }),
  },
  {
    matches: ctx => ctx.path.includes('hooks'),
    tip: () => ({
      suggestion:
        'Hooks must map event names to arrays of matchers with hook command objects',
      docLink: `${DOCS_BASE_URL}/hooks`,
    }),
  },
  {
    matches: ctx =>
      ctx.code === 'invalid_type' &&
      ctx.expected === 'boolean' &&
      ctx.received === 'string',
    tip: () => ({
      suggestion:
        'Use a JSON boolean (true or false) without quotes instead of a string',
    }),
  },
  {
    matches: ctx => ctx.code === 'unrecognized_keys',
    tip: ctx => ({
      suggestion:
        ctx.keys && ctx.keys.length > 0
          ? `Remove unrecognized key(s): ${ctx.keys.join(', ')}`
          : 'Check the key spelling against the settings schema',
      docLink: `${DOCS_BASE_URL}/settings`,
    }),
  },
  {
    matches: ctx =>
      ctx.code === 'invalid_value' &&
      Array.isArray(ctx.enumValues) &&
      ctx.enumValues.length > 0,
    tip: ctx => ({
      suggestion: `Valid options: ${ctx.enumValues!.join(', ')}`,
    }),
  },
  {
    matches: ctx =>
      ctx.path === '' && ctx.expected === 'object' && ctx.received === 'null',
    tip: () => ({
      suggestion: 'Ensure the settings file contains a valid JSON object "{}"',
    }),
  },
  {
    matches: ctx => ctx.path.startsWith('permissions.additionalDirectories'),
    tip: () => ({
      suggestion: 'Provide an array of directory path strings',
      docLink: `${DOCS_BASE_URL}/settings#permission-settings`,
    }),
  },
]

const PATH_DOC_LINKS: Record<string, string> = {
  permissions: `${DOCS_BASE_URL}/settings#permission-settings`,
  env: `${DOCS_BASE_URL}/settings#environment-variables`,
  hooks: `${DOCS_BASE_URL}/hooks`,
}

export function getValidationTip(context: TipContext): ValidationTip | null {
  for (const matcher of TIP_MATCHERS) {
    if (matcher.matches(context)) {
      return matcher.tip(context)
    }
  }
  const topLevelKey = context.path.split('.')[0]
  if (topLevelKey && PATH_DOC_LINKS[topLevelKey]) {
    return { docLink: PATH_DOC_LINKS[topLevelKey] }
  }
  return null
}
