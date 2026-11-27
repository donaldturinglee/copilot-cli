/**
 * Jupyter Notebook (`.ipynb`) reader, cell ID parser, and Anthropic API
 * tool-result block mapper (preserving code/markdown cells and image outputs).
 */

import type {
  ImageBlockParam,
  TextBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import { readFile } from 'fs/promises'
import type {
  NotebookCell,
  NotebookCellOutput,
  NotebookCellSource,
  NotebookCellSourceOutput,
  NotebookContent,
} from '../types/notebook.js'

const MAX_OUTPUT_TEXT_CHARS = 10_000

/**
 * Parses a synthetic `cell-N` identifier into a zero-based cell index,
 * returning `undefined` for non-numeric or real UUID cell IDs.
 */
export function parseCellId(cellId: string): number | undefined {
  const match = cellId.match(/^cell-(\d+)$/)
  if (!match?.[1]) {
    return undefined
  }
  const index = Number.parseInt(match[1], 10)
  return Number.isNaN(index) || index < 0 ? undefined : index
}

function normalizeSource(source: string | string[]): string {
  return Array.isArray(source) ? source.join('') : source
}

function truncateText(text: string): string {
  if (text.length <= MAX_OUTPUT_TEXT_CHARS) {
    return text
  }
  return (
    text.slice(0, MAX_OUTPUT_TEXT_CHARS) +
    `\n... [output truncated (${text.length} chars)]`
  )
}

function processCellOutput(
  output: NotebookCellOutput,
): NotebookCellSourceOutput {
  switch (output.output_type) {
    case 'stream':
      return {
        output_type: 'stream',
        text: truncateText(normalizeSource(output.text)),
      }
    case 'execute_result':
    case 'display_data': {
      const textPlain = output.data?.['text/plain']
      const png = output.data?.['image/png']
      const jpeg = output.data?.['image/jpeg']
      const text =
        textPlain !== undefined
          ? truncateText(normalizeSource(textPlain))
          : undefined
      const image =
        typeof png === 'string'
          ? { image_data: png.replace(/\s+/g, ''), media_type: 'image/png' as const }
          : typeof jpeg === 'string'
            ? {
                image_data: jpeg.replace(/\s+/g, ''),
                media_type: 'image/jpeg' as const,
              }
            : undefined
      return {
        output_type: output.output_type,
        ...(text !== undefined ? { text } : {}),
        ...(image ? { image } : {}),
      }
    }
    case 'error':
      return {
        output_type: 'error',
        text: truncateText(
          `${output.ename}: ${output.evalue}\n${(output.traceback ?? []).join('\n')}`,
        ),
      }
  }
}

function formatCell(
  cell: NotebookCell,
  index: number,
  language: string,
): NotebookCellSource {
  const cellId = cell.id ?? `cell-${index}`
  const outputs =
    cell.cell_type === 'code' && Array.isArray(cell.outputs)
      ? cell.outputs.map(processCellOutput)
      : undefined
  return {
    cellType: cell.cell_type,
    source: normalizeSource(cell.source),
    cell_id: cellId,
    ...(cell.cell_type === 'code' ? { language } : {}),
    ...(typeof cell.execution_count === 'number'
      ? { execution_count: cell.execution_count }
      : {}),
    ...(outputs && outputs.length > 0 ? { outputs } : {}),
  }
}

/**
 * Reads and parses a Jupyter `.ipynb` file into structured `NotebookCellSource`
 * entries along with the raw JSON text.
 */
export async function readNotebook(filePath: string): Promise<{
  cells: NotebookCellSource[]
  rawContent: string
  notebook: NotebookContent
}> {
  const rawContent = await readFile(filePath, { encoding: 'utf8' })
  let parsed: unknown
  try {
    parsed = JSON.parse(rawContent)
  } catch (error) {
    throw new Error(
      `Invalid JSON in notebook ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { cells?: unknown }).cells)
  ) {
    throw new Error(`Invalid notebook structure in ${filePath}: missing cells array.`)
  }
  const notebook = parsed as NotebookContent
  const language = notebook.metadata?.language_info?.name ?? 'python'
  const cells = notebook.cells.map((cell, index) =>
    formatCell(cell, index, language),
  )
  return { cells, rawContent, notebook }
}

/**
 * Converts parsed notebook cells into an Anthropic `tool_result` block with
 * XML-tagged cell text and inline image blocks for graphical cell outputs.
 */
export function mapNotebookCellsToToolResult(
  cells: readonly NotebookCellSource[],
  toolUseId: string,
): ToolResultBlockParam {
  const blocks: Array<TextBlockParam | ImageBlockParam> = []

  for (const cell of cells) {
    const header =
      cell.cellType === 'code'
        ? `<cell id="${cell.cell_id}" type="code" language="${cell.language ?? 'python'}"${cell.execution_count !== undefined ? ` execution_count="${cell.execution_count}"` : ''}>`
        : `<cell id="${cell.cell_id}" type="markdown">`

    const parts: string[] = [header, cell.source]
    const cellImages: ImageBlockParam[] = []

    if (cell.outputs && cell.outputs.length > 0) {
      const outputTexts: string[] = []
      for (const out of cell.outputs) {
        if (out.text) {
          outputTexts.push(out.text)
        }
        if (out.image) {
          cellImages.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: out.image.media_type,
              data: out.image.image_data,
            },
          })
        }
      }
      if (outputTexts.length > 0) {
        parts.push(`<outputs>\n${outputTexts.join('\n')}\n</outputs>`)
      }
    }

    parts.push('</cell>')
    blocks.push({ type: 'text', text: parts.join('\n') })
    blocks.push(...cellImages)
  }

  if (blocks.length === 0) {
    blocks.push({ type: 'text', text: '(Empty notebook)' })
  }

  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: blocks,
  }
}
