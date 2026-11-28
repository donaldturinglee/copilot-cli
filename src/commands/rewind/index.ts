/**
 * `/rewind` (alias `/checkpoint`) built-in command definition.
 */

import type { Command } from '../../types/command.js'
import { makeLocalCommand } from '../registry.js'
import { call, type RewindCommandContext } from './rewind.js'

export const rewindCommand: Command = makeLocalCommand({
  name: 'rewind',
  aliases: ['checkpoint'],
  description: 'Restore the code and/or conversation to a previous point',
  argumentHint: '[turns]',
  supportsNonInteractive: false,
  call: async (args, context) =>
    call(args, context as unknown as RewindCommandContext),
})
