/**
 * Maps agent types and output-style settings to telemetry `QuerySource` tags.
 */

import type { QuerySource } from '../constants/query_source.js'
import { getInitialSettings } from './settings/settings.js'

const DEFAULT_OUTPUT_STYLE_NAME = 'default'
const BUILTIN_OUTPUT_STYLES = new Set(['Explanatory', 'Learning'])

/**
 * Resolves the `QuerySource` tag for an agent invocation.
 */
export function getQuerySourceForAgent(
  agentType: string | undefined,
  isBuiltInAgent: boolean,
): QuerySource {
  if (isBuiltInAgent) {
    return agentType
      ? (`agent:builtin:${agentType}` as QuerySource)
      : 'agent:default'
  }
  return 'agent:custom'
}

/**
 * Resolves the `QuerySource` tag for the main REPL thread based on output style.
 */
export function getQuerySourceForRepl(): QuerySource {
  const style = getInitialSettings().outputStyle ?? DEFAULT_OUTPUT_STYLE_NAME
  if (style === DEFAULT_OUTPUT_STYLE_NAME) {
    return 'repl_main_thread'
  }
  return BUILTIN_OUTPUT_STYLES.has(style)
    ? (`repl_main_thread:outputStyle:${style}` as QuerySource)
    : 'repl_main_thread:outputStyle:custom'
}
