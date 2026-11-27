export const ENTER_PLAN_MODE_TOOL_DESCRIPTION =
  'Transitions the session into read-only plan mode to design an implementation plan before editing code.'

export const ENTER_PLAN_MODE_TOOL_PROMPT = `Use this tool to enter plan mode for non-trivial tasks requiring architectural design before writing code.
In plan mode, explore the codebase with read-only tools, write your plan to the session plan file, and call ExitPlanMode when ready for user approval.`
