/**
 * Interactive `/skills` dialog grouping project, user, policy, bundled, plugin,
 * and MCP skills with estimated description token counts.
 */

import React from 'react'
import { Box } from '../../ink/components/box.js'
import { useInput } from '../../ink/hooks/use_input.js'
import { estimateSkillFrontmatterTokens } from '../../skills/load_skills_dir.js'
import { getCommandName, type Command } from '../../types/command.js'
import { Dialog } from '../design_system/dialog.js'
import { ThemedText } from '../design_system/themed_text.js'

export interface SkillsMenuProps {
  commands: readonly Command[]
  onCancel: () => void
}

const GROUP_LABELS: ReadonlyArray<{
  key: string
  title: string
  match: (cmd: Command) => boolean
}> = [
  {
    key: 'project',
    title: 'Project skills (.copilot/skills)',
    match: c => c.type === 'prompt' && c.source === 'projectSettings',
  },
  {
    key: 'user',
    title: 'User skills (~/.copilot/skills)',
    match: c => c.type === 'prompt' && c.source === 'userSettings',
  },
  {
    key: 'policy',
    title: 'Managed skills',
    match: c => c.type === 'prompt' && c.source === 'policySettings',
  },
  {
    key: 'plugin',
    title: 'Plugin skills',
    match: c => c.type === 'prompt' && c.source === 'plugin',
  },
  {
    key: 'mcp',
    title: 'MCP prompt skills',
    match: c => c.type === 'prompt' && c.source === 'mcp',
  },
  {
    key: 'bundled',
    title: 'Bundled skills',
    match: c => c.type === 'prompt' && c.source === 'bundled',
  },
]

/**
 * Renders the grouped `/skills` overview dialog.
 */
export function SkillsMenu({
  commands,
  onCancel,
}: SkillsMenuProps): React.ReactNode {
  useInput((_ch, key) => {
    if (key.escape || key.return) {
      onCancel()
    }
  })

  const skills = commands.filter(
    cmd =>
      cmd.type === 'prompt' &&
      (cmd.loadedFrom === 'skills' ||
        cmd.loadedFrom === 'commands_DEPRECATED' ||
        cmd.loadedFrom === 'plugin' ||
        cmd.loadedFrom === 'mcp' ||
        cmd.loadedFrom === 'bundled' ||
        cmd.loadedFrom === 'managed') &&
      (cmd.isEnabled?.() ?? true),
  )

  return (
    <Dialog
      title="Skills"
      subtitle={`${skills.length} skill(s)`}
      onCancel={onCancel}
    >
      <Box flexDirection="column" gap={1}>
        {skills.length === 0 ? (
          <ThemedText dimColor>
            Create skills in .copilot/skills/ or ~/.copilot/skills/ (Press Esc to
            close)
          </ThemedText>
        ) : (
          GROUP_LABELS.map(group => {
            const items = skills
              .filter(group.match)
              .sort((a, b) => getCommandName(a).localeCompare(getCommandName(b)))
            if (items.length === 0) {
              return null
            }
            return (
              <Box key={group.key} flexDirection="column">
                <ThemedText bold>{group.title}</ThemedText>
                {items.map(skill => {
                  const tokens = estimateSkillFrontmatterTokens(skill)
                  return (
                    <Box key={skill.name} flexDirection="row" gap={1}>
                      <ThemedText color="suggestion">
                        /{getCommandName(skill)}
                      </ThemedText>
                      <ThemedText dimColor>
                        — {skill.description} (~{tokens} tokens)
                      </ThemedText>
                    </Box>
                  )
                })}
              </Box>
            )
          })
        )}
      </Box>
    </Dialog>
  )
}
