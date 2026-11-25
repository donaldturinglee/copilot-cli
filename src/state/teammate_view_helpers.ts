import { logEvent } from '../services/analytics/index.js'
import {
  isTerminalTaskStatus,
  type LocalAgentTaskState,
  type TaskState,
} from '../types/forward.js'
import type { AppState } from './app_state_store.js'

const PANEL_GRACE_MS = 30_000

function isLocalAgent(task: TaskState | undefined): task is LocalAgentTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'local_agent'
  )
}

function releaseTask(task: LocalAgentTaskState): LocalAgentTaskState {
  return {
    ...task,
    retain: false,
    messages: undefined,
    diskLoaded: false,
    evictAfter: isTerminalTaskStatus(task.status)
      ? Date.now() + PANEL_GRACE_MS
      : undefined,
  }
}

export function enterTeammateView(
  taskId: string,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  logEvent('tengu_transcript_view_enter', {})
  setAppState(prev => {
    const prevId = prev.viewingAgentTaskId
    const prevTask = prevId && prevId !== taskId ? prev.tasks[prevId] : undefined
    const targetTask = prev.tasks[taskId]
    const needsReleasePrev = isLocalAgent(prevTask) && prevTask.retain === true
    const needsRetainTarget =
      isLocalAgent(targetTask) &&
      (targetTask.retain !== true || targetTask.evictAfter !== undefined)

    if (
      prevId === taskId &&
      prev.viewSelectionMode === 'viewing-agent' &&
      !needsReleasePrev &&
      !needsRetainTarget
    ) {
      return prev
    }

    let tasks = prev.tasks
    if (needsReleasePrev || needsRetainTarget) {
      tasks = { ...prev.tasks }
      if (needsReleasePrev && prevId) {
        tasks[prevId] = releaseTask(prevTask)
      }
      if (needsRetainTarget) {
        tasks[taskId] = {
          ...targetTask,
          retain: true,
          evictAfter: undefined,
        }
      }
    }

    return {
      ...prev,
      tasks,
      viewingAgentTaskId: taskId,
      viewSelectionMode: 'viewing-agent',
    }
  })
}

export function exitTeammateView(
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  logEvent('tengu_transcript_view_exit', {})
  setAppState(prev => {
    const prevId = prev.viewingAgentTaskId
    if (prevId === undefined && prev.viewSelectionMode === 'none') {
      return prev
    }

    const prevTask = prevId ? prev.tasks[prevId] : undefined
    let tasks = prev.tasks
    if (prevId && isLocalAgent(prevTask) && prevTask.retain === true) {
      tasks = {
        ...prev.tasks,
        [prevId]: releaseTask(prevTask),
      }
    }

    return {
      ...prev,
      tasks,
      viewingAgentTaskId: undefined,
      viewSelectionMode: 'none',
    }
  })
}

export function stopOrDismissAgent(
  taskId: string,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  setAppState(prev => {
    const task = prev.tasks[taskId]
    if (!isLocalAgent(task)) {
      return prev
    }
    if (task.status === 'running') {
      task.abortController?.abort()
      return prev
    }
    if (task.evictAfter === 0) {
      return prev
    }

    const updatedTasks = {
      ...prev.tasks,
      [taskId]: {
        ...releaseTask(task),
        evictAfter: 0,
      },
    }

    const isViewing = prev.viewingAgentTaskId === taskId
    return {
      ...prev,
      tasks: updatedTasks,
      ...(isViewing
        ? {
            viewingAgentTaskId: undefined,
            viewSelectionMode: 'none' as const,
          }
        : {}),
    }
  })
}
