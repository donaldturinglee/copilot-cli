export const WEB_SEARCH_TOOL_DESCRIPTION =
  'Searches the web using Anthropic server-side web search (`web_search_20250305`) with optional domain filtering.'

export const WEB_SEARCH_TOOL_PROMPT = `Allows searching the web for up-to-date information beyond your knowledge cutoff.
Usage:
- Provide a concise search \`query\` (minimum 2 characters).
- Optionally filter results with \`allowed_domains\` OR \`blocked_domains\` (not both).
- Always include cited sources with Markdown links when presenting web search findings.`
