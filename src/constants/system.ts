/**
 * CLI system prompt prefixes and Anthropic billing/attribution header builder.
 */

import { getFeatureValueCachedMayBeStale } from '../services/analytics/growthbook.js'
import { isEnvDefinedFalsy } from '../utilities/env_utils.js'
import { isFeatureEnabled } from '../utilities/feature_flags.js'
import { getApiProvider } from '../utilities/model/providers.js'
import { getWorkload } from '../utilities/workload_context.js'

export const DEFAULT_PREFIX =
  "You are Claude Code, Anthropic's official CLI for Claude."

export const AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX =
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."

export const AGENT_SDK_PREFIX =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK."

export const CLI_SYSPROMPT_PREFIXES: ReadonlySet<string> = new Set([
  DEFAULT_PREFIX,
  AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX,
  AGENT_SDK_PREFIX,
])

function getMacroVersion(): string {
  const macroGlobal = (
    globalThis as unknown as { MACRO?: { VERSION?: string } }
  ).MACRO
  return macroGlobal?.VERSION ?? '0.0.1'
}

/**
 * Resolves the canonical CLI/SDK system prompt prefix block.
 */
export function getCliSyspromptPrefix(options?: {
  isNonInteractive: boolean
  hasAppendSystemPrompt: boolean
}): string {
  if (getApiProvider() === 'vertex') {
    return DEFAULT_PREFIX
  }
  if (options?.isNonInteractive) {
    return options.hasAppendSystemPrompt
      ? AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX
      : AGENT_SDK_PREFIX
  }
  return DEFAULT_PREFIX
}

/**
 * Formats the `x-anthropic-billing-header` system block carrying version,
 * message fingerprint, entrypoint, optional client attestation, and workload.
 */
export function getAttributionHeader(fingerprint: string): string {
  if (
    isEnvDefinedFalsy(process.env.COPILOT_CLI_ATTRIBUTION_HEADER) ||
    !getFeatureValueCachedMayBeStale('tengu_attribution_header', true)
  ) {
    return ''
  }
  const version = getMacroVersion()
  const entrypoint = process.env.COPILOT_CLI_ENTRYPOINT ?? 'unknown'
  const cch = isFeatureEnabled('NATIVE_CLIENT_ATTESTATION')
    ? ' cch=00000;'
    : ''
  const workload = getWorkload()
  const workloadPair = workload ? ` cc_workload=${workload};` : ''
  return `x-anthropic-billing-header: cc_version=${version}.${fingerprint}; cc_entrypoint=${entrypoint};${cch}${workloadPair}`
}
