/**
 * Compile-time / runtime feature flag abstraction compatible with Bun's
 * `bun:bundle` `feature()` dead-code elimination as well as Node.js dev/test runs.
 */

export const FEATURE_FLAGS = [
  'ABLATION_BASELINE',
  'AGENT_MEMORY_SNAPSHOT',
  'AGENT_TRIGGERS',
  'AGENT_TRIGGERS_REMOTE',
  'ALLOW_TEST_VERSIONS',
  'ANTI_DISTILLATION_CC',
  'AUTO_THEME',
  'AWAY_SUMMARY',
  'BASH_CLASSIFIER',
  'BG_SESSIONS',
  'BREAK_CACHE_COMMAND',
  'BRIDGE_MODE',
  'BUDDY',
  'BUILDING_CLAUDE_APPS',
  'BUILTIN_EXPLORE_PLAN_AGENTS',
  'BYOC_ENVIRONMENT_RUNNER',
  'CACHED_MICROCOMPACT',
  'CCR_AUTO_CONNECT',
  'CCR_MIRROR',
  'CCR_REMOTE_SETUP',
  'CHICAGO_MCP',
  'COMMIT_ATTRIBUTION',
  'COMPACTION_REMINDERS',
  'CONNECTOR_TEXT',
  'CONTEXT_COLLAPSE',
  'COORDINATOR_MODE',
  'COWORKER_TYPE_TELEMETRY',
  'DAEMON',
  'DIRECT_CONNECT',
  'DOWNLOAD_USER_SETTINGS',
  'DUMP_SYSTEM_PROMPT',
  'ENHANCED_TELEMETRY_BETA',
  'EXPERIMENTAL_SKILL_SEARCH',
  'EXTRACT_MEMORIES',
  'FILE_PERSISTENCE',
  'FORK_SUBAGENT',
  'HARD_FAIL',
  'HISTORY_PICKER',
  'HISTORY_SNIP',
  'HOOK_PROMPTS',
  'IS_LIBC_GLIBC',
  'IS_LIBC_MUSL',
  'KAIROS',
  'KAIROS_BRIEF',
  'KAIROS_CHANNELS',
  'KAIROS_DREAM',
  'KAIROS_GITHUB_WEBHOOKS',
  'KAIROS_PUSH_NOTIFICATION',
  'LODESTONE',
  'MCP_RICH_OUTPUT',
  'MCP_SKILLS',
  'MEMORY_SHAPE_TELEMETRY',
  'MESSAGE_ACTIONS',
  'MONITOR_TOOL',
  'NATIVE_CLIENT_ATTESTATION',
  'NATIVE_CLIPBOARD_IMAGE',
  'NEW_INIT',
  'OVERFLOW_TEST_TOOL',
  'PERFETTO_TRACING',
  'POWERSHELL_AUTO_MODE',
  'PROACTIVE',
  'PROMPT_CACHE_BREAK_DETECTION',
  'QUICK_SEARCH',
  'REACTIVE_COMPACT',
  'REVIEW_ARTIFACT',
  'RUN_SKILL_GENERATOR',
  'SELF_HOSTED_RUNNER',
  'SHOT_STATS',
  'SKILL_IMPROVEMENT',
  'SKIP_DETECTION_WHEN_AUTOUPDATES_DISABLED',
  'SLOW_OPERATION_LOGGING',
  'SSH_REMOTE',
  'STREAMLINED_OUTPUT',
  'TEAMMEM',
  'TEMPLATES',
  'TERMINAL_PANEL',
  'TOKEN_BUDGET',
  'TORCH',
  'TRANSCRIPT_CLASSIFIER',
  'TREE_SITTER_BASH',
  'TREE_SITTER_BASH_SHADOW',
  'UDS_INBOX',
  'ULTRAPLAN',
  'ULTRATHINK',
  'UNATTENDED_RETRY',
  'UPLOAD_USER_SETTINGS',
  'VERIFICATION_AGENT',
  'VOICE_MODE',
  'WEB_BROWSER_TOOL',
  'WORKFLOW_SCRIPTS',
] as const

export type FeatureFlag = (typeof FEATURE_FLAGS)[number]

const runtimeOverrides = new Map<FeatureFlag, boolean>()

/**
 * Runtime feature flag check for non-bundled (Node/dev/test) execution.
 * In Bun compiled builds, call sites that require compile-time DCE can use
 * `import { feature } from 'bun:bundle'` directly, while runtime-configurable
 * code can call `isFeatureEnabled`.
 */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  const override = runtimeOverrides.get(flag)
  if (override !== undefined) return override
  const envVal = process.env[`COPILOT_FEATURE_${flag}`]
  if (envVal === '1' || envVal === 'true') return true
  if (envVal === '0' || envVal === 'false') return false
  return false
}

export function setFeatureOverrideForTesting(
  flag: FeatureFlag,
  enabled: boolean | undefined,
): void {
  if (enabled === undefined) {
    runtimeOverrides.delete(flag)
  } else {
    runtimeOverrides.set(flag, enabled)
  }
}

export function clearFeatureOverridesForTesting(): void {
  runtimeOverrides.clear()
}

export type MacroValues = {
  readonly VERSION: string
  readonly BUILD_TIME: string
  readonly FEEDBACK_CHANNEL: string
  readonly ISSUES_EXPLAINER: string
  readonly NATIVE_PACKAGE_URL: string
  readonly PACKAGE_URL: string
  readonly VERSION_CHANGELOG: string
}

export const DEFAULT_MACROS: MacroValues = {
  VERSION: '0.1.0',
  BUILD_TIME: '',
  FEEDBACK_CHANNEL: '',
  ISSUES_EXPLAINER: 'report the issue via the project issue tracker',
  NATIVE_PACKAGE_URL: '',
  PACKAGE_URL: 'copilot-cli',
  VERSION_CHANGELOG: '',
}

export function ensureMacroGlobals(overrides?: Partial<MacroValues>): void {
  const g = globalThis as unknown as { MACRO?: MacroValues }
  if (!g.MACRO || overrides) {
    g.MACRO = {
      ...DEFAULT_MACROS,
      ...g.MACRO,
      ...overrides,
    }
  }
}
