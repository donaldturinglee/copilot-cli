export const ASK_USER_QUESTION_TOOL_DESCRIPTION =
  'Asks the user 1 to 4 structured multiple-choice questions to clarify requirements or preferences.'

export const ASK_USER_QUESTION_TOOL_PROMPT = `Use this tool when you need to ask the user structured clarifying questions during execution.
- Supply 1 to 4 questions, each with 2 to 4 unique options and a concise header (<= 12 chars).
- Set \`multiSelect: true\` if multiple answers are allowed.`
