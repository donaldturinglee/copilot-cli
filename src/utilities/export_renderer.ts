import type { Message } from '../types/message.js'
import { parseDisplayTags } from './display_tags.js'

/**
 * Render a conversation transcript to clean shareable Markdown for `/export`
 * and `/copy`.
 */
export function renderTranscriptMarkdown(
  messages: readonly Message[],
  options?: { title?: string },
): string {
  const lines: string[] = [
    `# ${options?.title ?? 'Copilot CLI Conversation Export'}`,
    '',
  ]

  for (const msg of messages) {
    if (msg.type === 'user' && !msg.isMeta) {
      const content = msg.message.content
      const raw =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .filter(b => b.type === 'text')
                .map(b => (b.type === 'text' ? b.text : ''))
                .join('\n')
            : ''
      const parsed = parseDisplayTags(raw)
      if (!parsed.plainText && !parsed.commandName) continue
      lines.push('## User')
      lines.push('')
      if (parsed.commandName) lines.push(`\`${parsed.commandName}\``)
      if (parsed.plainText) lines.push(parsed.plainText)
      lines.push('')
    } else if (msg.type === 'assistant' && !msg.isMeta) {
      const blocks = Array.isArray(msg.message.content)
        ? msg.message.content
        : []
      const textParts: string[] = []
      for (const b of blocks) {
        if (b.type === 'text' && b.text.trim()) textParts.push(b.text)
        else if (b.type === 'tool_use') {
          textParts.push(`> Tool: \`${b.name}\``)
        }
      }
      if (textParts.length === 0) continue
      lines.push('## Assistant')
      lines.push('')
      lines.push(textParts.join('\n\n'))
      lines.push('')
    }
  }

  return lines.join('\n').trimEnd() + '\n'
}
