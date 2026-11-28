/**
 * Local `/rewind` command handler opening the interactive `MessageSelector`
 * checkpoint rollback dialog (or falling back to N-turn rollback when invoked
 * with a numeric argument in non-interactive/test command contexts).
 */

import type { LocalCommandResult } from '../../types/command.js'
import type { Message } from '../../types/message.js'
import type { LocalJsxCommandContext } from '../../types/command.js'

export interface RewindCommandContext extends LocalJsxCommandContext {
  openMessageSelector?: () => void
}

/**
 * Executes `/rewind` — opens the interactive checkpoint selector when wired
 * into REPL, or rewinds N turns directly when given a numeric argument.
 */
export async function call(
  args: string,
  context: RewindCommandContext,
): Promise<LocalCommandResult> {
  const trimmed = args.trim()
  if (!trimmed && context.openMessageSelector) {
    context.openMessageSelector()
    return { type: 'skip' }
  }

  const count = Math.max(1, Number.parseInt(trimmed, 10) || 1)
  let removed = 0
  context.setMessages(prev => {
    const next: Message[] = [...prev]
    let turnsLeft = count
    while (next.length > 0 && turnsLeft > 0) {
      const popped = next.pop()
      removed++
      if (popped?.type === 'user' && !popped.isMeta) {
        turnsLeft--
      }
    }
    return next
  })

  return {
    type: 'text',
    value: `Rewound ${count} turn(s) (${removed} message(s) removed).`,
  }
}
