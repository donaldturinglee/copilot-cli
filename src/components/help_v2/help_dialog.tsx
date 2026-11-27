import React, { useState } from 'react'
import { Box } from '../../ink/components/box.js'
import { DEFAULT_BINDINGS } from '../../keybindings/default_bindings.js'
import type { Command } from '../../types/command.js'
import { getCommandName, isCommandEnabled } from '../../types/command.js'
import { Dialog } from '../design_system/dialog.js'
import { Tab, Tabs } from '../design_system/tabs.js'
import { ThemedText } from '../design_system/themed_text.js'

export type HelpDialogProps = {
  commands: readonly Command[]
  onClose: () => void
}

/**
 * Multi-tab `/help` reference dialog showing slash commands and keybindings.
 */
export function HelpDialog({
  commands,
  onClose,
}: HelpDialogProps): React.ReactNode {
  const [tab, setTab] = useState('commands')
  const visibleCommands = commands.filter(
    c => !c.isHidden && isCommandEnabled(c),
  )

  return (
    <Dialog
      title="Copilot CLI Help"
      subtitle="Tab/Arrows to switch tabs · Esc to close"
      width={76}
      overlayId="help-dialog"
      onCancel={onClose}
    >
      <Tabs activeTabId={tab} onTabChange={setTab}>
        <Tab id="commands" title="Commands">
          <Box flexDirection="column">
            {visibleCommands.slice(0, 18).map(cmd => (
              <Box
                key={cmd.name}
                flexDirection="row"
                justifyContent="space-between"
                gap={2}
              >
                <ThemedText color="claude" bold>
                  /{getCommandName(cmd)}
                </ThemedText>
                <ThemedText dimColor wrap="truncate-end">
                  {cmd.description}
                </ThemedText>
              </Box>
            ))}
            {visibleCommands.length > 18 ? (
              <ThemedText dimColor>
                … and {visibleCommands.length - 18} more commands (type `/` to
                autocomplete)
              </ThemedText>
            ) : null}
          </Box>
        </Tab>

        <Tab id="shortcuts" title="Shortcuts">
          <Box flexDirection="column">
            {DEFAULT_BINDINGS.slice(0, 3).flatMap(block =>
              Object.entries(block.bindings)
                .slice(0, 6)
                .map(([chord, action]) => (
                  <Box
                    key={`${block.context}-${chord}`}
                    flexDirection="row"
                    justifyContent="space-between"
                    gap={2}
                  >
                    <ThemedText color="suggestion" bold>
                      {chord}
                    </ThemedText>
                    <ThemedText dimColor>
                      [{block.context}] {action ?? 'unbound'}
                    </ThemedText>
                  </Box>
                )),
            )}
          </Box>
        </Tab>

        <Tab id="tips" title="Tips">
          <Box flexDirection="column" gap={0}>
            <ThemedText>• Prefix a line with `!` to run a shell command directly.</ThemedText>
            <ThemedText>• Type `@` to fuzzy-complete workspace files.</ThemedText>
            <ThemedText>• Press `Shift+Tab` to cycle permission modes.</ThemedText>
            <ThemedText>• Press `Ctrl+O` to expand/collapse tool outputs.</ThemedText>
            <ThemedText>• Run `/vim` to toggle 11-state Vim input editing.</ThemedText>
          </Box>
        </Tab>
      </Tabs>
    </Dialog>
  )
}
