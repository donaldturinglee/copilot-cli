export const TODO_WRITE_TOOL_DESCRIPTION =
  'Creates and updates a structured task list for the current session or agent.'

export const TODO_WRITE_TOOL_PROMPT = `Use this tool to create and manage a structured task checklist for complex multi-step work.
Each item has \`content\`, \`status\` ("pending", "in_progress", or "completed"), and \`activeForm\`.
When every item is marked "completed", the active list clears automatically.`
