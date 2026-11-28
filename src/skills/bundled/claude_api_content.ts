/**
 * Reconstructed static SDK reference documentation and templates for the
 * bundled `claude-api` skill.
 */

export const CLAUDE_API_SKILL_PROMPT = `Guide the user in building applications with the Anthropic / Claude SDK and Messages API.

Key guidelines:
- Prefer current model IDs (Opus: \`{{OPUS_ID}}\`, Sonnet: \`{{SONNET_ID}}\`, Haiku: \`{{HAIKU_ID}}\`).
- Use streaming (\`client.messages.stream\`) for interactive or large-output calls.
- Place \`cache_control: { type: 'ephemeral' }\` breakpoints on stable system prompts and tool definitions for prompt caching.
- Define tool \`input_schema\` with strict JSON Schema objects and return matching \`tool_result\` blocks paired by \`tool_use_id\`.`

export const CLAUDE_API_SKILL_FILES: Readonly<Record<string, string>> = {
  'typescript/messages.md': `# TypeScript SDK (\`@anthropic-ai/sdk\`)

\`\`\`ts
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()
const message = await client.messages.create({
  model: '{{SONNET_ID}}',
  max_tokens: 4096,
  messages: [{ role: 'user', content: 'Hello!' }],
})
\`\`\``,
  'python/messages.md': `# Python SDK (\`anthropic\`)

\`\`\`python
import anthropic

client = anthropic.Anthropic()
message = client.messages.create(
    model="{{SONNET_ID}}",
    max_tokens=4096,
    messages=[{"role": "user", "content": "Hello!"}],
)
\`\`\``,
  'shared/tool_use.md': `# Tool Use & Prompt Caching

- Provide \`tools: [{ name, description, input_schema }]\` on \`messages.create\`.
- When \`stop_reason === "tool_use"\`, execute every \`tool_use\` block and reply with a single \`role: "user"\` message containing all \`tool_result\` blocks first.`,
}
