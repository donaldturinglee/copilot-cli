import { z } from 'zod'
import { KEYBINDING_CONTEXTS } from './types.js'

export const KeybindingContextSchema = z.enum(KEYBINDING_CONTEXTS)

export const KeybindingBlockSchema = z.object({
  context: KeybindingContextSchema,
  bindings: z.record(z.string(), z.string().nullable()),
})

export const KeybindingConfigFileSchema = z.object({
  $schema: z.string().optional(),
  bindings: z.array(KeybindingBlockSchema),
})

export type KeybindingConfigFileParsed = z.infer<
  typeof KeybindingConfigFileSchema
>
