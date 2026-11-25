import type { TaskType } from './forward.js'
import type { AgentId } from './ids.js'
import type { AssistantMessage, NormalizedUserMessage } from './message.js'

export type BashProgress = {
  type: 'bash_progress'
  output: string
  fullOutput: string
  elapsedTimeSeconds: number
  totalLines: number
  totalBytes?: number
  taskId?: string
  timeoutMs?: number
}

export type PowerShellProgress = {
  type: 'powershell_progress'
  output: string
  fullOutput: string
  elapsedTimeSeconds: number
  totalLines: number
  totalBytes?: number
  taskId?: string
  timeoutMs?: number
}

export type ShellProgress = BashProgress | PowerShellProgress

export type AgentToolProgress = {
  type: 'agent_progress'
  message: AssistantMessage | NormalizedUserMessage
  prompt: string
  agentId: AgentId
}

export type SkillToolProgress = {
  type: 'skill_progress'
  message: AssistantMessage | NormalizedUserMessage
  prompt: string
  agentId: AgentId
}

export type McpProgress = {
  type: 'mcp_progress'
  status: 'started' | 'progress' | 'completed' | 'failed'
  serverName: string
  toolName: string
  elapsedTimeMs?: number
  progress?: number
  total?: number
  progressMessage?: string
}

export type WebSearchProgress =
  | {
      type: 'query_update'
      query: string
    }
  | {
      type: 'search_results_received'
      resultCount: number
      query: string
    }

export type TaskOutputProgress = {
  type: 'waiting_for_task'
  taskDescription: string
  taskType: TaskType
}

export type ReplToolProgress = {
  type: 'repl_progress'
  output?: string
  elapsedTimeSeconds?: number
}

export type SdkWorkflowProgress = {
  type: 'phase' | 'agent'
  index: number
  phaseIndex: number
  name?: string
  status?: string
  summary?: string
  error?: string
}

export type ToolProgressData =
  | BashProgress
  | PowerShellProgress
  | AgentToolProgress
  | SkillToolProgress
  | McpProgress
  | WebSearchProgress
  | TaskOutputProgress
  | ReplToolProgress
