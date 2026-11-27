/**
 * `TodoWriteTool` (`TodoWrite`):
 * Persists structured todo lists to `AppState.todos[agentId ?? sessionId]`
 * and clears the list when all todos are marked `completed`.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { z } from 'zod/v4'
import { getSessionId } from '../../bootstrap/state.js'
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../../constants/tool_limits.js'
import { buildTool, type ToolUseContext } from '../../tool.js'
import type { TodoList } from '../../utilities/todo/types.js'
import { TODO_WRITE_TOOL_NAME } from './constants.js'
import {
  TODO_WRITE_TOOL_DESCRIPTION,
  TODO_WRITE_TOOL_PROMPT,
} from './prompt.js'

const TodoItemSchema = z.object({
  id: z.string().optional(),
  content: z.string().min(1).describe('Task description in imperative form'),
  status: z.enum(['pending', 'in_progress', 'completed']),
  activeForm: z
    .string()
    .min(1)
    .optional()
    .describe('Present-continuous phrasing shown while in_progress'),
})

const TodoWriteInputSchema = z.object({
  todos: z.array(TodoItemSchema).describe('The updated todo list'),
})

export type TodoWriteInput = z.infer<typeof TodoWriteInputSchema>

export interface TodoWriteOutput {
  oldTodos: TodoList
  newTodos: TodoList
}

export const TodoWriteTool = buildTool<TodoWriteInput, TodoWriteOutput>({
  name: TODO_WRITE_TOOL_NAME,
  searchHint: 'create or update the structured session todo list',
  maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
  inputSchema: TodoWriteInputSchema,

  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => false,
  interruptBehavior: () => 'block',

  async description() {
    return TODO_WRITE_TOOL_DESCRIPTION
  },

  async prompt() {
    return TODO_WRITE_TOOL_PROMPT
  },

  async checkPermissions(input) {
    return { behavior: 'allow', updatedInput: input }
  },

  async call(input, context: ToolUseContext) {
    const key = context.agentId ?? getSessionId()
    const oldTodos: TodoList = context.getAppState?.().todos[key] ?? []
    const allCompleted =
      input.todos.length > 0 &&
      input.todos.every(todo => todo.status === 'completed')
    const storedTodos: TodoList = allCompleted ? [] : [...input.todos]

    context.setAppState?.(prev => ({
      ...prev,
      todos: {
        ...prev.todos,
        [key]: storedTodos,
      },
    }))

    return {
      data: {
        oldTodos,
        newTodos: input.todos,
      },
    }
  },

  mapToolResultToToolResultBlockParam(_output, toolUseId): ToolResultBlockParam {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content:
        'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress.',
    }
  },
})
