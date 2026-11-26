/**
 * djb2 string hash — fast non-cryptographic hash returning a signed 32-bit int.
 * Deterministic across runtimes (unlike Bun.hash which uses wyhash).
 */
export function djb2Hash(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return hash
}

/**
 * Hash arbitrary content for change detection.
 */
export function hashContent(content: string): string {
  if (typeof Bun !== 'undefined') {
    return Bun.hash(content).toString()
  }
  const crypto = require('crypto') as typeof import('crypto')
  return crypto.createHash('sha256').update(content).digest('hex')
}

/**
 * Hash two strings without allocating a concatenated temp string.
 */
export function hashPair(first: string, second: string): string {
  if (typeof Bun !== 'undefined') {
    return Bun.hash(second, Bun.hash(first)).toString()
  }
  const crypto = require('crypto') as typeof import('crypto')
  return crypto
    .createHash('sha256')
    .update(first)
    .update('\0')
    .update(second)
    .digest('hex')
}
