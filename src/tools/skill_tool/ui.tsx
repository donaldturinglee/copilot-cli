/**
 * Ink TUI renderers for `SkillTool`.
 */

import React from 'react'
import { ThemedText } from '../../components/design_system/themed_text.js'
import { Box } from '../../ink/components/box.js'
import type { ProgressMessage } from '../../types/message.js'
import type { SkillToolProgress } from '../../types/tools.js'
import type { SkillToolInput, SkillToolOutput } from './skill_tool.js'

/**
 * Renders the skill name and optional arguments in the transcript.
 */
export function renderSkillToolUseMessage(
  input: Partial<SkillToolInput>,
): React.ReactNode {
  if (!input.skill) {
    return null
  }
  return (
    <ThemedText dimColor>
      {input.skill}
      {input.args ? ` ${input.args}` : ''}
    </ThemedText>
  )
}

/**
 * Renders live progress for forked skill subagents.
 */
export function renderSkillToolProgressMessage(
  progressMessages: ProgressMessage<SkillToolProgress>[],
): React.ReactNode {
  if (progressMessages.length === 0) {
    return null
  }
  return (
    <ThemedText dimColor>
      Running forked skill ({progressMessages.length} step(s))…
    </ThemedText>
  )
}

/**
 * Renders completion status for inline and forked skill executions.
 */
export function renderSkillToolResultMessage(
  output: SkillToolOutput,
): React.ReactNode {
  if (output.mode === 'fork') {
    return <ThemedText dimColor>Completed forked skill {output.commandName}</ThemedText>
  }
  const details: string[] = [`Loaded skill ${output.commandName}`]
  if (output.allowedTools?.length) {
    details.push(`${output.allowedTools.length} tool rule(s) allowed`)
  }
  if (output.model) {
    details.push(`model ${output.model}`)
  }
  return (
    <Box flexDirection="row">
      <ThemedText dimColor>{details.join(' · ')}</ThemedText>
    </Box>
  )
}
