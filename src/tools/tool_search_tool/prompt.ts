/**
 * Model-facing description and prompt text for `ToolSearchTool` (`ToolSearch`).
 */

export const TOOL_SEARCH_TOOL_DESCRIPTION =
  'Searches for and loads deferred tool schemas by exact name (`select:ToolA,ToolB`) or keyword query.'

export const TOOL_SEARCH_TOOL_PROMPT = `Fetches full schema definitions for deferred tools so they can be called.
Query forms:
1. Direct selection: \`select:ToolName\` or \`select:ToolA,ToolB\` loads exact tool schemas immediately.
2. Keyword search: \`notebook edit\` or \`+web fetch\` (+term requires a match on that term).
Returns \`tool_reference\` blocks that automatically make the matching tools available on subsequent turns.`
