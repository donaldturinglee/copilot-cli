/**
 * Shared multi-agent spawn contract types used by tool definitions without
 * pulling in Phase 9 subagent runtime implementations.
 */

export type AgentIsolationMode = 'worktree'

export interface SpawnAgentSpec {
  description: string
  prompt: string
  subagentType?: string
  model?: string
  runInBackground?: boolean
  isolation?: AgentIsolationMode
  name?: string
  teamName?: string
}

export interface SpawnAgentResult {
  agentId: string
  status: 'completed' | 'async_launched' | 'failed'
  output?: string
  worktreePath?: string
  worktreeBranch?: string
}
