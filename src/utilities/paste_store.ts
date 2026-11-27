export const LARGE_PASTE_LINE_THRESHOLD = 3
export const LARGE_PASTE_CHAR_THRESHOLD = 400

export const PASTE_CHIP_RE = /\[Pasted text #(\d+)(?: \+\d+ lines)?\]/g

export type StoredPaste = {
  id: number
  content: string
  lineCount: number
  token: string
}

let nextPasteId = 1
const pasteMap = new Map<number, StoredPaste>()

export function shouldFoldPaste(text: string): boolean {
  const lineCount = text.split(/\r?\n/).length
  return (
    lineCount > LARGE_PASTE_LINE_THRESHOLD ||
    text.length > LARGE_PASTE_CHAR_THRESHOLD
  )
}

export function createPasteChip(content: string): StoredPaste {
  const id = nextPasteId++
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lineCount = normalized.split('\n').length
  const extraLines = Math.max(0, lineCount - 1)
  const token =
    extraLines > 0
      ? `[Pasted text #${id} +${extraLines} lines]`
      : `[Pasted text #${id}]`
  const stored: StoredPaste = {
    id,
    content: normalized,
    lineCount,
    token,
  }
  pasteMap.set(id, stored)
  return stored
}

export function getPasteContent(id: number): StoredPaste | undefined {
  return pasteMap.get(id)
}

export function getAllStoredPastes(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [id, item] of pasteMap) {
    out[String(id)] = item.content
  }
  return out
}

/**
 * Expand all `[Pasted text #N +X lines]` tokens back into their full verbatim
 * pasted payload before sending to the model or executing a command.
 */
export function expandPastedText(
  input: string,
  extraLookup?: ReadonlyMap<number, string>,
): string {
  return input.replace(PASTE_CHIP_RE, (match, rawId: string) => {
    const id = Number(rawId)
    const fromExtra = extraLookup?.get(id)
    if (fromExtra !== undefined) return fromExtra
    return pasteMap.get(id)?.content ?? match
  })
}

export function clearPasteStore(): void {
  pasteMap.clear()
  nextPasteId = 1
}
