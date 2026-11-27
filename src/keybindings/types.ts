/**
 * Contextual keybinding system types covering 19 UI contexts and multi-keystroke chords.
 */

export const KEYBINDING_CONTEXTS = [
  'Global',
  'Chat',
  'Autocomplete',
  'Settings',
  'Confirmation',
  'Tabs',
  'Transcript',
  'HistorySearch',
  'Task',
  'ThemePicker',
  'Scroll',
  'Help',
  'Attachments',
  'Footer',
  'MessageSelector',
  'DiffDialog',
  'ModelPicker',
  'Select',
  'Vim',
] as const

export type KeybindingContextName = (typeof KEYBINDING_CONTEXTS)[number]

export type ParsedKeystroke = {
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  super: boolean
}

export type ParsedBinding = {
  chord: ParsedKeystroke[]
  action: string | null
  context: KeybindingContextName
  source?: 'default' | 'user'
  rawKey?: string
}

export type KeybindingBlock = {
  context: KeybindingContextName
  bindings: Record<string, string | null>
}

export type KeybindingConfigFile = {
  $schema?: string
  bindings: KeybindingBlock[]
}
