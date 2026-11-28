/**
 * Startup approval dialog for untrusted project `.mcp.json` MCP servers.
 */

import React from 'react'
import { Box } from '../ink/components/box.js'
import { recordProjectMcpServerDecisions } from '../services/mcp_server_approval.js'
import { Select } from './custom_select/select.js'
import { Dialog } from './design_system/dialog.js'
import { ThemedText } from './design_system/themed_text.js'

export interface McpServerApprovalDialogProps {
  serverNames: readonly string[]
  onDone: () => void
}

/**
 * Prompts the user to approve or reject pending `.mcp.json` servers before
 * spawning project-defined MCP commands.
 */
export function MCPServerApprovalDialog({
  serverNames,
  onDone,
}: McpServerApprovalDialogProps): React.ReactNode {
  const handleDecision = (choice: string) => {
    if (choice === 'approve_all') {
      recordProjectMcpServerDecisions({
        approved: serverNames,
        rejected: [],
      })
    } else {
      recordProjectMcpServerDecisions({
        approved: [],
        rejected: serverNames,
      })
    }
    onDone()
  }

  return (
    <Dialog
      title="Project MCP Servers Detected"
      subtitle={`${serverNames.length} server(s) in .mcp.json`}
      borderColor="permission"
      onCancel={() => handleDecision('reject_all')}
    >
      <Box flexDirection="column" gap={1}>
        <ThemedText>
          This workspace defines MCP server(s): {serverNames.join(', ')}.
          Only enable MCP servers from repositories you trust.
        </ThemedText>
        <Select
          options={[
            { label: 'Approve project MCP servers', value: 'approve_all' },
            { label: 'Reject project MCP servers', value: 'reject_all' },
          ]}
          onChange={handleDecision}
          onCancel={() => handleDecision('reject_all')}
        />
      </Box>
    </Dialog>
  )
}
