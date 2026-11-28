/**
 * Disk persistence and jq/Read query guidance for oversized MCP tool outputs.
 */

import {
  generatePreview,
  PERSISTED_OUTPUT_TAG,
  persistToolResult,
  PREVIEW_SIZE_BYTES,
} from './tool_result_storage.js'
import { inferCompactSchema } from './mcp_validation.js'

/**
 * Persists an oversized MCP text/JSON output to disk and builds a structured
 * `<persisted-output>` summary including an inferred compact JSON schema when
 * the payload is valid JSON.
 */
export function saveMcpOutput(
  text: string,
  toolUseId: string,
): { filepath: string; formattedMessage: string } {
  let parsedJson: unknown
  let isJson = false
  const trimmed = text.trim()
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      parsedJson = JSON.parse(trimmed)
      isJson = true
    } catch {
      isJson = false
    }
  }

  const { filepath, originalSize } = persistToolResult(text, toolUseId, isJson)
  const { preview, hasMore } = generatePreview(text, PREVIEW_SIZE_BYTES)
  const schemaHint = isJson
    ? `\nInferred JSON schema: ${inferCompactSchema(parsedJson)}`
    : ''

  const formattedMessage = getLargeOutputInstructions({
    filepath,
    originalSize,
    schemaHint,
    preview: hasMore ? `${preview}\n...` : preview,
  })

  return { filepath, formattedMessage }
}

/**
 * Formats instructions for inspecting persisted MCP outputs.
 */
export function getLargeOutputInstructions(params: {
  filepath: string
  originalSize: number
  schemaHint?: string
  preview: string
}): string {
  const sizeKb = (params.originalSize / 1024).toFixed(1)
  return [
    PERSISTED_OUTPUT_TAG,
    `MCP tool output (${sizeKb}KB) exceeds inline token limit and was saved to: ${params.filepath}${params.schemaHint ?? ''}`,
    'Use Read (with offset/limit) or Grep to inspect relevant sections.',
    '',
    'Preview:',
    params.preview,
    '</persisted-output>',
  ].join('\n')
}
