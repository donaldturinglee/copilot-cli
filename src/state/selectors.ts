import type {
  InProcessTeammateTaskState,
  LocalAgentTaskState,
} from '../types/forward.js'
import type { AppState } from './app_state_store.js'

export type ActiveAgentForInput =
  | { type: 'leader' }
  | { type: 'viewed'; task: InProcessTeammateTaskState }
  | { type: 'named_agent'; task: LocalAgentTaskState }

export function getViewedTeammateTask(
  appState: Pick<AppState, 'viewingAgentTaskId' | 'tasks'>,
): InProcessTeammateTaskState | undefined {
  const taskId = appState.viewingAgentTaskId
  if (!taskId) return undefined
  const task = appState.tasks[taskId]
  if (!task || task.type !== 'in_process_teammate') {
    return undefined
  }
  return task
}

export function getActiveAgentForInput(
  appState: AppState,
): ActiveAgentForInput {
  const viewedTeammate = getViewedTeammateTask(appState)
  if (viewedTeammate) {
    return { type: 'viewed', task: viewedTeammate }
  }
  if (appState.viewingAgentTaskId) {
    const task = appState.tasks[appState.viewingAgentTaskId]
    if (task && task.type === 'local_agent') {
      return { type: 'named_agent', task }
    }
  }
  return { type: 'leader' }
}
