import type { KeybindingConfigFile } from './types.js'

export function createKeybindingsTemplate(): KeybindingConfigFile {
  return {
    $schema: 'https://copilot-cli.dev/schemas/keybindings.json',
    bindings: [
      {
        context: 'Chat',
        bindings: {
          'ctrl+x ctrl+e': 'chat:externalEditor',
          'ctrl+s': 'chat:stash',
        },
      },
    ],
  }
}

export function formatKeybindingsTemplateJson(): string {
  return JSON.stringify(createKeybindingsTemplate(), null, 2) + '\n'
}
