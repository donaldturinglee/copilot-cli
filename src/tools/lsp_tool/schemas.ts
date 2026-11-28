/**
 * Input and output Zod schemas for all 9 `LSPTool` operations.
 */

import { z } from 'zod/v4'

export const LSP_OPERATIONS = [
  'goToDefinition',
  'findReferences',
  'hover',
  'documentSymbol',
  'workspaceSymbol',
  'goToImplementation',
  'prepareCallHierarchy',
  'incomingCalls',
  'outgoingCalls',
] as const

export type LspOperation = (typeof LSP_OPERATIONS)[number]

export const LspToolInputSchema = z.strictObject({
  operation: z
    .enum(LSP_OPERATIONS)
    .describe('The LSP code-intelligence operation to execute'),
  filePath: z
    .string()
    .min(1)
    .describe('Absolute or workspace-relative file path'),
  line: z
    .number()
    .int()
    .positive()
    .describe('1-based line number in the file'),
  character: z
    .number()
    .int()
    .positive()
    .describe('1-based character offset on the line'),
})

export type LspToolInput = z.infer<typeof LspToolInputSchema>

export interface LspToolOutput {
  operation: LspOperation
  result: string
  filePath: string
  resultCount?: number
  fileCount?: number
}
