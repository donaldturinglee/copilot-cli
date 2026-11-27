/**
 * Zod schema for external permission-prompt MCP tool results (`--permission-prompt-tool`).
 */

import { z } from 'zod/v4'
import { lazySchema } from '../lazy_schema.js'
import { permissionUpdateSchema } from './permission_update_schema.js'

export const permissionPromptToolResultSchema = lazySchema(() =>
  z.discriminatedUnion('behavior', [
    z.object({
      behavior: z.literal('allow'),
      updatedInput: z.record(z.string(), z.unknown()),
      updatedPermissions: z.array(permissionUpdateSchema()).optional(),
    }),
    z.object({
      behavior: z.literal('deny'),
      message: z.string(),
      interrupt: z.boolean().optional(),
    }),
  ]),
)

export type PermissionPromptToolResult = z.infer<
  ReturnType<typeof permissionPromptToolResultSchema>
>
