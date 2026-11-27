/**
 * `SyntheticOutputTool` (`StructuredOutput`) + WeakMap-cached `Ajv` JSON Schema
 * validator factory (`createSyntheticOutputTool(jsonSchema)`) powering
 * `--json-schema` structured output enforcement in headless `-p` / SDK mode.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import Ajv, { type ValidateFunction } from 'ajv'
import { z } from 'zod/v4'
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../../constants/tool_limits.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../../constants/tools.js'
import {
  buildTool,
  type Tool,
  type ToolInputJsonSchema,
} from '../../tool.js'
import { createAttachmentMessage } from '../../utilities/attachments.js'

const ajvInstance = new Ajv({
  allErrors: true,
  strict: false,
})

const validatorCache = new WeakMap<Record<string, unknown>, ValidateFunction>()

function getOrCompileValidator(
  schema: Record<string, unknown>,
): ValidateFunction {
  const cached = validatorCache.get(schema)
  if (cached) {
    return cached
  }
  const compiled = ajvInstance.compile(schema)
  validatorCache.set(schema, compiled)
  return compiled
}

const SyntheticOutputSchema = z.record(z.string(), z.unknown())

export type SyntheticOutputInput = Record<string, unknown>

export const SYNTHETIC_OUTPUT_TOOL_DESCRIPTION =
  'Returns the final structured JSON response conforming to the requested output schema.'

export const SYNTHETIC_OUTPUT_TOOL_PROMPT =
  'Return your final response by calling this tool with a JSON object matching the provided schema.'

/**
 * Default schema-less `StructuredOutput` tool definition.
 */
export const SyntheticOutputTool: Tool<SyntheticOutputInput, string> =
  buildTool<SyntheticOutputInput, string>({
    name: SYNTHETIC_OUTPUT_TOOL_NAME,
    searchHint: 'return validated structured JSON output',
    maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
    alwaysLoad: true,
    inputSchema: SyntheticOutputSchema,

    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    interruptBehavior: () => 'block',

    async description() {
      return SYNTHETIC_OUTPUT_TOOL_DESCRIPTION
    },

    async prompt() {
      return SYNTHETIC_OUTPUT_TOOL_PROMPT
    },

    async checkPermissions(input) {
      return { behavior: 'allow', updatedInput: input }
    },

    async call(input) {
      return {
        data: 'Structured output provided successfully',
        newMessages: [
          createAttachmentMessage({
            type: 'structured_output',
            data: input,
          }),
        ],
      }
    },

    mapToolResultToToolResultBlockParam(output, toolUseId): ToolResultBlockParam {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: output,
      }
    },
  })

/**
 * Creates a schema-enforcing `StructuredOutput` tool backed by a WeakMap-cached
 * `Ajv` validator. Rejects invalid inputs in `validateInput()` with detailed
 * schema errors so the model can self-correct and retry.
 */
export function createSyntheticOutputTool(
  jsonSchema: Record<string, unknown>,
): Tool<SyntheticOutputInput, string> {
  // Compile eagerly to catch malformed schemas up front and populate WeakMap cache
  const validate = getOrCompileValidator(jsonSchema)

  const inputJSONSchema: ToolInputJsonSchema = {
    type: 'object',
    ...jsonSchema,
  }

  return buildTool<SyntheticOutputInput, string>({
    name: SYNTHETIC_OUTPUT_TOOL_NAME,
    searchHint: 'return validated structured JSON output',
    maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
    alwaysLoad: true,
    inputSchema: SyntheticOutputSchema,
    inputJSONSchema,

    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    interruptBehavior: () => 'block',

    async description() {
      return SYNTHETIC_OUTPUT_TOOL_DESCRIPTION
    },

    async prompt() {
      return SYNTHETIC_OUTPUT_TOOL_PROMPT
    },

    async checkPermissions(input) {
      return { behavior: 'allow', updatedInput: input }
    },

    async validateInput(input) {
      const ok = validate(input)
      if (!ok) {
        const errors = (validate.errors ?? [])
          .map(err => `${err.instancePath || '<root>'}: ${err.message ?? 'invalid'}`)
          .join('; ')
        return {
          result: false,
          message: `StructuredOutput failed JSON schema validation: ${errors || 'schema mismatch'}. Fix the fields and call StructuredOutput again.`,
          errorCode: 1,
        }
      }
      return { result: true }
    },

    async call(input) {
      return {
        data: 'Structured output provided successfully',
        newMessages: [
          createAttachmentMessage({
            type: 'structured_output',
            data: input,
          }),
        ],
      }
    },

    mapToolResultToToolResultBlockParam(output, toolUseId): ToolResultBlockParam {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: output,
      }
    },
  })
}
