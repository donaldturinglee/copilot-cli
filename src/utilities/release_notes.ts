import { getMacroVersion } from '../constants/version.js'

export type ReleaseNoteEntry = {
  version: string
  highlights: string[]
}

export function getReleaseNotes(): ReleaseNoteEntry[] {
  return [
    {
      version: getMacroVersion(),
      highlights: [
        'Interactive 3-slot fullscreen REPL with 80-line overscan virtualized transcript scrolling',
        '11-state Vim editing engine with atomic [Image #N] chip boundary protection',
        '8-tier priority typeahead completion powered by pure-TS FileIndex',
        'Interactive per-tool permission dialogs with persistent settings.local.json allow rules',
        'Complete Slash command framework, Output Styles, 3-tab /config, and /doctor diagnostics',
      ],
    },
  ]
}
