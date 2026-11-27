/**
 * Auto-mode allowlist and fast-path tool classification.
 * Read-only / safe introspection tools bypass the LLM classifier;
 * workspace edit tools follow the acceptEdits fast path once `safetyCheck` passes.
 */

import {
  ASK_USER_QUESTION_TOOL_NAME,
  BRIEF_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
} from '../../constants/tools.js'
import { normalizeLegacyToolName } from './permission_rule_parser.js'

/**
 * Tools that never mutate external state or execute arbitrary code and are
 * automatically allowed in `auto` mode without invoking the transcript classifier.
 */
export const AUTO_MODE_ALLOWLISTED_TOOLS: ReadonlySet<string> = new Set([
  FILE_READ_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
  BRIEF_TOOL_NAME,
])

/**
 * File-mutation tools eligible for `acceptEdits` fast-path approval inside
 * allowed working directories (ONLY after `safetyCheck` passes).
 */
export const AUTO_MODE_EDIT_TOOLS: ReadonlySet<string> = new Set([
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
])

export function isAutoModeAllowlistedTool(toolName: string): boolean {
  return AUTO_MODE_ALLOWLISTED_TOOLS.has(normalizeLegacyToolName(toolName))
}

export function isAutoModeEditTool(toolName: string): boolean {
  return AUTO_MODE_EDIT_TOOLS.has(normalizeLegacyToolName(toolName))
}
