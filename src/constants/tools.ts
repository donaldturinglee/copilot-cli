/**
 * Canonical tool name constants and role/mode allow/disallow sets.
 */

export const FILE_READ_TOOL_NAME = 'Read'
export const FILE_EDIT_TOOL_NAME = 'Edit'
export const FILE_WRITE_TOOL_NAME = 'Write'
export const NOTEBOOK_EDIT_TOOL_NAME = 'NotebookEdit'
export const GLOB_TOOL_NAME = 'Glob'
export const GREP_TOOL_NAME = 'Grep'
export const BASH_TOOL_NAME = 'Bash'
export const POWERSHELL_TOOL_NAME = 'PowerShell'
export const TOOL_SEARCH_TOOL_NAME = 'ToolSearch'
export const WEB_FETCH_TOOL_NAME = 'WebFetch'
export const WEB_SEARCH_TOOL_NAME = 'WebSearch'
export const ENTER_PLAN_MODE_TOOL_NAME = 'EnterPlanMode'
export const EXIT_PLAN_MODE_TOOL_NAME = 'ExitPlanMode'
export const ENTER_WORKTREE_TOOL_NAME = 'EnterWorktree'
export const EXIT_WORKTREE_TOOL_NAME = 'ExitWorktree'
export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'
export const TODO_WRITE_TOOL_NAME = 'TodoWrite'
export const SYNTHETIC_OUTPUT_TOOL_NAME = 'StructuredOutput'
export const BRIEF_TOOL_NAME = 'SendUserMessage'
export const CONFIG_TOOL_NAME = 'Config'

export const ALL_AGENT_DISALLOWED_TOOLS: ReadonlySet<string> = new Set([
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  CONFIG_TOOL_NAME,
  ENTER_WORKTREE_TOOL_NAME,
  EXIT_WORKTREE_TOOL_NAME,
])

export const CUSTOM_AGENT_DISALLOWED_TOOLS: ReadonlySet<string> = new Set([
  ...ALL_AGENT_DISALLOWED_TOOLS,
])

export const ASYNC_AGENT_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  FILE_READ_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  BASH_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
])

export const IN_PROCESS_TEAMMATE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  ...ASYNC_AGENT_ALLOWED_TOOLS,
  BRIEF_TOOL_NAME,
])

export const COORDINATOR_MODE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'Agent',
  'SendMessage',
  'TaskStop',
  'TaskOutput',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  TOOL_SEARCH_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  BRIEF_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
])
