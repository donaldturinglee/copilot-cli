/**
 * `AskUserQuestionTool` (`AskUserQuestion`):
 * Structured multiple-choice user elicitation tool with uniqueness validation,
 * optional preview validation, and `requiresUserInteraction: true`.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { z } from 'zod/v4'
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../../constants/tool_limits.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../../constants/tools.js'
import { buildTool } from '../../tool.js'
import {
  ASK_USER_QUESTION_TOOL_DESCRIPTION,
  ASK_USER_QUESTION_TOOL_PROMPT,
} from './prompt.js'

const QuestionOptionSchema = z.object({
  label: z.string().min(1).describe('Short display text for this option'),
  description: z.string().describe('Explanation of what this option implies'),
  markdown: z
    .string()
    .optional()
    .describe('Optional preview snippet displayed when focused'),
})

const QuestionItemSchema = z.object({
  question: z.string().min(1).describe('The question to ask the user'),
  header: z
    .string()
    .min(1)
    .max(32)
    .describe('Short chip label for this question'),
  options: z
    .array(QuestionOptionSchema)
    .min(2)
    .max(4)
    .describe('Available choices (2 to 4 options)'),
  multiSelect: z
    .boolean()
    .default(false)
    .describe('Allow selecting multiple options'),
})

const AskUserQuestionInputSchema = z.object({
  questions: z
    .array(QuestionItemSchema)
    .min(1)
    .max(4)
    .describe('Questions to ask the user (1 to 4 questions)'),
  answers: z
    .record(z.string(), z.string())
    .optional()
    .describe('User answers populated by the permission/UI layer'),
  annotations: z
    .record(
      z.string(),
      z.object({
        preview: z.string().optional(),
        notes: z.string().optional(),
      }),
    )
    .optional()
    .describe('Optional per-question annotations'),
})

export type AskUserQuestionInput = z.infer<typeof AskUserQuestionInputSchema>

export interface AskUserQuestionOutput {
  questions: AskUserQuestionInput['questions']
  answers: Record<string, string>
  annotations?: AskUserQuestionInput['annotations']
}

export const AskUserQuestionTool = buildTool<
  AskUserQuestionInput,
  AskUserQuestionOutput
>({
  name: ASK_USER_QUESTION_TOOL_NAME,
  searchHint: 'ask the user structured multiple-choice clarifying questions',
  maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
  shouldDefer: true,
  inputSchema: AskUserQuestionInputSchema,

  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  requiresUserInteraction: () => true,
  interruptBehavior: () => 'block',

  async description() {
    return ASK_USER_QUESTION_TOOL_DESCRIPTION
  },

  async prompt() {
    return ASK_USER_QUESTION_TOOL_PROMPT
  },

  async validateInput(input) {
    const seenQuestions = new Set<string>()
    for (const q of input.questions) {
      if (seenQuestions.has(q.question)) {
        return {
          result: false,
          message: `Duplicate question text found: "${q.question}". All questions must be unique.`,
          errorCode: 1,
        }
      }
      seenQuestions.add(q.question)

      const seenLabels = new Set<string>()
      for (const opt of q.options) {
        if (seenLabels.has(opt.label)) {
          return {
            result: false,
            message: `Duplicate option label "${opt.label}" in question "${q.question}".`,
            errorCode: 2,
          }
        }
        seenLabels.add(opt.label)
      }
    }
    return { result: true }
  },

  async call(input) {
    return {
      data: {
        questions: input.questions,
        answers: input.answers ?? {},
        ...(input.annotations ? { annotations: input.annotations } : {}),
      },
    }
  },

  mapToolResultToToolResultBlockParam(output, toolUseId): ToolResultBlockParam {
    const entries = Object.entries(output.answers)
    if (entries.length === 0) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: 'User did not provide answers to the questions.',
      }
    }
    const formatted = entries
      .map(([question, answer]) => `"${question}"="${answer}"`)
      .join(', ')
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: `User has answered your questions: ${formatted}.`,
    }
  },
})
