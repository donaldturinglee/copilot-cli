/**
 * High-confidence secret scanner (36 curated gitleaks rules, lazily compiled)
 * for team memory write and push guardrails. Never returns or logs matched
 * secret values.
 */

export interface SecretMatch {
  ruleId: string
  label: string
}

interface SecretRuleDef {
  id: string
  pattern: string
  flags?: string
}

// Assemble Anthropic prefixes at runtime to avoid triggering static repo scanners
const ANT_KEY_PFX = ['sk', 'ant', 'api'].join('-')
const ANT_ADMIN_PFX = ['sk', 'ant', 'admin'].join('-')

const RAW_SECRET_RULES: readonly SecretRuleDef[] = [
  // Cloud (5)
  {
    id: 'aws-access-token',
    pattern: '(?:^|[^A-Za-z0-9])((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})(?:[^A-Za-z0-9]|$)',
  },
  {
    id: 'gcp-api-key',
    pattern: '(?:^|[^A-Za-z0-9_-])(AIza[0-9A-Za-z\\-_]{35})(?:[^A-Za-z0-9_-]|$)',
  },
  {
    id: 'azure-ad-client-secret',
    pattern: '(?:^|[^a-zA-Z0-9_~.-])([a-zA-Z0-9_~.-]{3}8Q~[a-zA-Z0-9_~.-]{31,34})(?:[^a-zA-Z0-9_~.-]|$)',
  },
  {
    id: 'digitalocean-pat',
    pattern: '(?:^|[^a-f0-9])(dop_v1_[a-f0-9]{64})(?:[^a-f0-9]|$)',
  },
  {
    id: 'digitalocean-access-token',
    pattern: '(?:^|[^a-f0-9])(doo_v1_[a-f0-9]{64})(?:[^a-f0-9]|$)',
  },

  // AI APIs (4)
  {
    id: 'anthropic-api-key',
    pattern: `(${ANT_KEY_PFX}03-[a-zA-Z0-9_\\-]{93}AA)`,
  },
  {
    id: 'anthropic-admin-api-key',
    pattern: `(${ANT_ADMIN_PFX}01-[a-zA-Z0-9_\\-]{93}AA)`,
  },
  {
    id: 'openai-api-key',
    pattern: '(sk-(?:proj|svcacct|admin)-[A-Za-z0-9_\\-]{20,}T3BlbkFJ[A-Za-z0-9_\\-]{20,}|sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20})',
  },
  {
    id: 'huggingface-access-token',
    pattern: '(?:^|[^A-Za-z])(hf_[A-Za-z]{34})(?:[^A-Za-z]|$)',
  },

  // Version Control (7)
  {
    id: 'github-pat',
    pattern: '(?:^|[^A-Za-z0-9_])(ghp_[0-9a-zA-Z]{36})(?:[^A-Za-z0-9_]|$)',
  },
  {
    id: 'github-fine-grained-pat',
    pattern: '(?:^|[^A-Za-z0-9_])(github_pat_[0-9a-zA-Z_]{82})(?:[^A-Za-z0-9_]|$)',
  },
  {
    id: 'github-app-token',
    pattern: '(?:^|[^A-Za-z0-9_])((?:ghu|ghs)_[0-9a-zA-Z]{36})(?:[^A-Za-z0-9_]|$)',
  },
  {
    id: 'github-oauth',
    pattern: '(?:^|[^A-Za-z0-9_])(gho_[0-9a-zA-Z]{36})(?:[^A-Za-z0-9_]|$)',
  },
  {
    id: 'github-refresh-token',
    pattern: '(?:^|[^A-Za-z0-9_])(ghr_[0-9a-zA-Z]{36})(?:[^A-Za-z0-9_]|$)',
  },
  {
    id: 'gitlab-pat',
    pattern: '(?:^|[^A-Za-z0-9_-])(glpat-[0-9a-zA-Z_\\-]{20})(?:[^A-Za-z0-9_-]|$)',
  },
  {
    id: 'gitlab-deploy-token',
    pattern: '(?:^|[^A-Za-z0-9_-])(gldt-[0-9a-zA-Z_\\-]{20})(?:[^A-Za-z0-9_-]|$)',
  },

  // Communication (5)
  {
    id: 'slack-bot-token',
    pattern: '(xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*)',
  },
  {
    id: 'slack-user-token',
    pattern: '(xox[pe]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9-]{20,})',
  },
  {
    id: 'slack-app-token',
    pattern: '(xapp-\\d-[A-Z0-9]+-\\d+-[a-z0-9]+)',
    flags: 'i',
  },
  {
    id: 'twilio-api-key',
    pattern: '(?:^|[^A-Za-z0-9])(SK[0-9a-fA-F]{32})(?:[^A-Za-z0-9]|$)',
  },
  {
    id: 'sendgrid-api-token',
    pattern: '(SG\\.[a-zA-Z0-9_\\-]{22}\\.[a-zA-Z0-9_\\-]{43})',
  },

  // Dev Tooling (6)
  {
    id: 'npm-access-token',
    pattern: '(?:^|[^A-Za-z0-9_])(npm_[a-zA-Z0-9]{36})(?:[^A-Za-z0-9_]|$)',
  },
  {
    id: 'pypi-upload-token',
    pattern: '(pypi-AgEIcHlwaS5vcmc[A-Za-z0-9\\-_]{50,1000})',
  },
  {
    id: 'databricks-api-token',
    pattern: '(?:^|[^a-f0-9])(dapi[a-f0-9]{32}(?:-\\d)?)(?:[^a-f0-9]|$)',
  },
  {
    id: 'hashicorp-tf-api-token',
    pattern: '([a-z0-9]{14}\\.atlasv1\\.[a-z0-9\\-_=]{60,70})',
    flags: 'i',
  },
  {
    id: 'pulumi-api-token',
    pattern: '(?:^|[^a-f0-9])(pul-[a-f0-9]{40})(?:[^a-f0-9]|$)',
  },
  {
    id: 'postman-api-token',
    pattern: '(PMAK-[a-f0-9]{24}-[a-f0-9]{34})',
    flags: 'i',
  },

  // Observability (5)
  {
    id: 'grafana-api-key',
    pattern: '(?:^|[^A-Za-z0-9+/=])(eyJrIjoi[A-Za-z0-9+/=]{70,400})(?:[^A-Za-z0-9+/=]|$)',
  },
  {
    id: 'grafana-cloud-api-token',
    pattern: '(glc_[A-Za-z0-9+/=_\\-]{32,400})',
  },
  {
    id: 'grafana-service-account-token',
    pattern: '(glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8})',
  },
  {
    id: 'sentry-user-token',
    pattern: '(sntryu_[a-f0-9]{64})',
  },
  {
    id: 'sentry-org-token',
    pattern: '(sntrys_eyJpYXQiO[A-Za-z0-9+/=]{10,200}_[A-Za-z0-9+/=]{43})',
  },

  // Payment & Commerce (3)
  {
    id: 'stripe-access-token',
    pattern: '((?:sk|rk)_(?:test|live|prod)_[0-9a-zA-Z]{10,99})',
  },
  {
    id: 'shopify-access-token',
    pattern: '(shpat_[a-fA-F0-9]{32})',
  },
  {
    id: 'shopify-shared-secret',
    pattern: '(shpss_[a-fA-F0-9]{32})',
  },

  // Crypto (1)
  {
    id: 'private-key',
    pattern: '(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]+?-----END [A-Z0-9 ]*PRIVATE KEY-----)',
    flags: 'i',
  },
]

const ACRONYM_MAP: Readonly<Record<string, string>> = {
  aws: 'AWS',
  gcp: 'GCP',
  api: 'API',
  pat: 'PAT',
  ad: 'AD',
  tf: 'TF',
  oauth: 'OAuth',
  npm: 'NPM',
  pypi: 'PyPI',
  jwt: 'JWT',
  github: 'GitHub',
  gitlab: 'GitLab',
  openai: 'OpenAI',
  digitalocean: 'DigitalOcean',
  huggingface: 'HuggingFace',
  hashicorp: 'HashiCorp',
  sendgrid: 'SendGrid',
}

interface CompiledSecretRule {
  id: string
  label: string
  regex: RegExp
  globalRegex: RegExp
}

let compiledRulesCache: CompiledSecretRule[] | null = null

/**
 * Formats a kebab-case secret rule ID into a human-readable title with
 * normalized acronyms.
 */
export function getSecretLabel(ruleId: string): string {
  return ruleId
    .split('-')
    .map(word => {
      const lower = word.toLowerCase()
      return (
        ACRONYM_MAP[lower] ??
        (word.length > 0 ? word[0]!.toUpperCase() + word.slice(1) : '')
      )
    })
    .join(' ')
}

function getCompiledRules(): readonly CompiledSecretRule[] {
  if (compiledRulesCache) {
    return compiledRulesCache
  }
  compiledRulesCache = RAW_SECRET_RULES.map(rule => ({
    id: rule.id,
    label: getSecretLabel(rule.id),
    regex: new RegExp(rule.pattern, rule.flags ?? ''),
    globalRegex: new RegExp(rule.pattern, `${rule.flags ?? ''}g`),
  }))
  return compiledRulesCache
}

/**
 * Scans `content` for high-confidence credentials/keys, returning deduplicated
 * `{ ruleId, label }` matches without ever exposing matched secret strings.
 */
export function scanForSecrets(content: string): SecretMatch[] {
  if (!content) {
    return []
  }
  const matches: SecretMatch[] = []
  for (const rule of getCompiledRules()) {
    if (rule.regex.test(content)) {
      matches.push({ ruleId: rule.id, label: rule.label })
    }
  }
  return matches
}

/**
 * Redacts all detected secret tokens in `content` with `[REDACTED]`,
 * preserving surrounding non-secret boundary characters.
 */
export function redactSecrets(content: string): string {
  if (!content) {
    return content
  }
  let output = content
  for (const rule of getCompiledRules()) {
    rule.globalRegex.lastIndex = 0
    output = output.replace(
      rule.globalRegex,
      (fullMatch: string, group1?: string) => {
        if (typeof group1 === 'string' && group1.length > 0) {
          return fullMatch.replace(group1, '[REDACTED]')
        }
        return '[REDACTED]'
      },
    )
  }
  return output
}
