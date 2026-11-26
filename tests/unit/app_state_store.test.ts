import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getMainLoopModelOverride,
  resetStateForTests,
  setOriginalCwd,
} from '../../src/bootstrap/state.js'
import {
  getDefaultAppState,
} from '../../src/state/app_state_store.js'
import {
  externalMetadataToAppState,
  onChangeAppState,
  registerSettingsChangeAuthCacheInvalidator,
} from '../../src/state/on_change_app_state.js'
import {
  getActiveAgentForInput,
  getViewedTeammateTask,
} from '../../src/state/selectors.js'
import { createStore } from '../../src/state/store.js'
import {
  enterTeammateView,
  exitTeammateView,
  stopOrDismissAgent,
} from '../../src/state/teammate_view_helpers.js'
import {
  getGlobalConfig,
  resetTestConfigForTesting,
} from '../../src/utilities/config.js'
import { getClaudeConfigHomeDir } from '../../src/utilities/env_utils.js'
import {
  setPermissionModeChangedListener,
  setSessionMetadataChangedListener,
} from '../../src/utilities/session_state.js'
import { resetSettingsCache } from '../../src/utilities/settings/settings_cache.js'

let tempRoot = ''
let savedConfigDir: string | undefined

beforeEach(() => {
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  tempRoot = mkdtempSync(join(tmpdir(), 'copilot-app-state-test-'))
  process.env.CLAUDE_CONFIG_DIR = join(tempRoot, '.copilot')
  getClaudeConfigHomeDir.cache.clear?.()
  resetStateForTests()
  setOriginalCwd(join(tempRoot, 'project'))
  resetSettingsCache()
  resetTestConfigForTesting()
})

afterEach(() => {
  setSessionMetadataChangedListener(null)
  setPermissionModeChangedListener(null)
  if (savedConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  }
  getClaudeConfigHomeDir.cache.clear?.()
  resetSettingsCache()
  resetTestConfigForTesting()
  rmSync(tempRoot, { recursive: true, force: true })
})

describe('Step 1.2 AppStateStore and diff-driven side effects', () => {
  test('createStore bails out on Object.is identity and notifies subscribers on change', () => {
    let changeCount = 0
    let subscribeCount = 0
    const store = createStore({ count: 0 }, () => {
      changeCount++
    })
    const unsubscribe = store.subscribe(() => {
      subscribeCount++
    })

    store.setState(prev => prev)
    expect(changeCount).toBe(0)
    expect(subscribeCount).toBe(0)

    store.setState(prev => ({ count: prev.count + 1 }))
    expect(store.getState().count).toBe(1)
    expect(changeCount).toBe(1)
    expect(subscribeCount).toBe(1)

    unsubscribe()
    store.setState(prev => ({ count: prev.count + 1 }))
    expect(subscribeCount).toBe(1)
  })

  test('createStore(getDefaultAppState(), onChangeAppState) runs outside React and triggers side effects', () => {
    const metadataEvents: Array<Record<string, unknown>> = []
    const modeEvents: string[] = []
    let authInvalidations = 0

    setSessionMetadataChangedListener(meta => metadataEvents.push(meta))
    setPermissionModeChangedListener(mode => modeEvents.push(mode))
    const unregisterAuth = registerSettingsChangeAuthCacheInvalidator(() => {
      authInvalidations++
    })

    const store = createStore(getDefaultAppState(), onChangeAppState)

    // 1. Permission mode change notifies metadata + raw mode listeners
    store.setState(prev => ({
      ...prev,
      toolPermissionContext: {
        ...prev.toolPermissionContext,
        mode: 'plan',
      },
      isUltraplanMode: true,
    }))
    expect(modeEvents).toEqual(['plan'])
    expect(metadataEvents).toEqual([
      { permission_mode: 'plan', is_ultraplan_mode: true },
    ])

    // 2. mainLoopModel change persists to userSettings and updates bootstrap override
    store.setState(prev => ({ ...prev, mainLoopModel: 'opus' }))
    expect(getMainLoopModelOverride()).toBe('opus')

    // 3. expandedView and verbose persist to global config
    store.setState(prev => ({
      ...prev,
      expandedView: 'tasks',
      verbose: true,
    }))
    expect(getGlobalConfig().showExpandedTodos).toBe(true)
    expect(getGlobalConfig().showSpinnerTree).toBe(false)
    expect(getGlobalConfig().verbose).toBe(true)

    // 4. settings reference change invalidates auth caches and reapplies settings.env
    store.setState(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        env: { TEST_APP_STATE_ENV: 'applied-via-store' },
      },
    }))
    expect(authInvalidations).toBe(1)
    unregisterAuth()
  })

  test('externalMetadataToAppState restores permission mode and ultraplan flag', () => {
    const initial = getDefaultAppState()
    const restored = externalMetadataToAppState({
      permission_mode: 'acceptEdits',
      is_ultraplan_mode: true,
    })(initial)
    expect(restored.toolPermissionContext.mode).toBe('acceptEdits')
    expect(restored.isUltraplanMode).toBe(true)
  })

  test('selectors and teammate view helpers manage viewed agents and eviction lifecycle', () => {
    const controller = new AbortController()
    const store = createStore(getDefaultAppState())
    store.setState(prev => ({
      ...prev,
      tasks: {
        'team-1': {
          id: 'team-1',
          type: 'in_process_teammate',
          status: 'running',
        },
        'agent-1': {
          id: 'agent-1',
          type: 'local_agent',
          status: 'running',
          abortController: controller,
        },
        'agent-done': {
          id: 'agent-done',
          type: 'local_agent',
          status: 'completed',
        },
      },
    }))

    expect(getActiveAgentForInput(store.getState())).toEqual({ type: 'leader' })

    enterTeammateView('team-1', store.setState)
    expect(getViewedTeammateTask(store.getState())?.id).toBe('team-1')
    expect(getActiveAgentForInput(store.getState()).type).toBe('viewed')

    enterTeammateView('agent-1', store.setState)
    expect(getActiveAgentForInput(store.getState()).type).toBe('named_agent')
    const agentTask = store.getState().tasks['agent-1']
    expect(agentTask?.type === 'local_agent' && agentTask.retain).toBe(true)

    // Stopping a running local_agent aborts its controller without evicting
    stopOrDismissAgent('agent-1', store.setState)
    expect(controller.signal.aborted).toBe(true)

    // Dismissing a completed local_agent sets evictAfter = 0 and exits view
    enterTeammateView('agent-done', store.setState)
    stopOrDismissAgent('agent-done', store.setState)
    const dismissed = store.getState().tasks['agent-done']
    expect(dismissed?.type === 'local_agent' && dismissed.evictAfter).toBe(0)
    expect(store.getState().viewingAgentTaskId).toBeUndefined()

    exitTeammateView(store.setState)
    expect(store.getState().viewSelectionMode).toBe('none')
  })
})
