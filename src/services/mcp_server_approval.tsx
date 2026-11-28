/**
 * Interactive startup consent helper for pending project-scoped `.mcp.json`
 * servers (`enabledMcpjsonServers` / `disabledMcpjsonServers`).
 */

import { saveCurrentProjectConfig } from '../utilities/config.js'
import {
  doesEnterpriseMcpConfigExist,
  getMcpConfigsByScope,
  getProjectMcpServerStatus,
} from './mcp/config.js'

/**
 * Returns names of project `.mcp.json` servers awaiting user approval.
 */
export function getPendingProjectMcpServers(): string[] {
  if (doesEnterpriseMcpConfigExist()) {
    return []
  }
  const project = getMcpConfigsByScope('project')
  return Object.keys(project.servers).filter(
    name => getProjectMcpServerStatus(name) === 'pending',
  )
}

/**
 * Persists approval and rejection decisions for project-scoped `.mcp.json` servers.
 */
export function recordProjectMcpServerDecisions(params: {
  approved: readonly string[]
  rejected: readonly string[]
}): void {
  saveCurrentProjectConfig(prev => {
    const enabled = new Set(prev.enabledMcpjsonServers ?? [])
    const disabled = new Set(prev.disabledMcpjsonServers ?? [])
    for (const name of params.approved) {
      enabled.add(name)
      disabled.delete(name)
    }
    for (const name of params.rejected) {
      disabled.add(name)
      enabled.delete(name)
    }
    return {
      ...prev,
      enabledMcpjsonServers: Array.from(enabled),
      disabledMcpjsonServers: Array.from(disabled),
    }
  })
}
