/**
 * Short 5-letter request ID hashing and reply parsing for approving tool
 * permission requests over MCP Channels (e.g. `yes abcde` / `no abcde`).
 */

const ALPHABET = 'abcdefghijkmnopqrstuvwxyz' // 25 letters (omits 'l' for readability)
const REPLY_REGEX = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

/**
 * Hashes `toolUseId` (FNV-1a 32-bit) into a deterministic 5-character code from
 * the 25-letter unambiguous alphabet.
 */
export function shortRequestId(toolUseId: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < toolUseId.length; i++) {
    hash ^= toolUseId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  let code = ''
  let rem = hash
  for (let i = 0; i < 5; i++) {
    code += ALPHABET[rem % ALPHABET.length]!
    rem = Math.floor(rem / ALPHABET.length)
  }
  return code
}

/**
 * Parses an inbound channel reply such as `"y abcde"` or `"no abcde"`.
 */
export function tryParsePermissionReply(text: string): {
  approved: boolean
  requestId: string
} | null {
  const match = text.match(REPLY_REGEX)
  if (!match || !match[1] || !match[2]) {
    return null
  }
  const verb = match[1].toLowerCase()
  return {
    approved: verb === 'y' || verb === 'yes',
    requestId: match[2].toLowerCase(),
  }
}
