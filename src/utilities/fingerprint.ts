/**
 * Deterministic 3-hex-char request fingerprint derived from first user message
 * characters `[4, 7, 20]` and CLI version for `x-anthropic-billing-header`.
 */

import { createHash } from 'crypto'
import type { AssistantMessage, UserMessage } from '../types/message.js'

export const FINGERPRINT_SALT = '59cf53e54c78'
const FINGERPRINT_INDICES = [4, 7, 20] as const

function getMacroVersion(): string {
  const macroGlobal = (
    globalThis as unknown as { MACRO?: { VERSION?: string } }
  ).MACRO
  return macroGlobal?.VERSION ?? '0.0.1'
}

/**
 * Extracts text from the first `user` message in a normalized API message list.
 */
export function extractFirstMessageText(
  messages: ReadonlyArray<UserMessage | AssistantMessage>,
): string {
  const firstUser = messages.find(m => m.type === 'user')
  if (!firstUser) {
    return ''
  }
  const content = firstUser.message.content
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    const firstText = content.find(block => block.type === 'text')
    if (firstText && firstText.type === 'text') {
      return firstText.text
    }
  }
  return ''
}

/**
 * Computes the 3-character hex fingerprint for `messageText` and `version`.
 */
export function computeFingerprint(
  messageText: string,
  version: string = getMacroVersion(),
): string {
  const chars = FINGERPRINT_INDICES.map(i => messageText[i] || '0').join('')
  return createHash('sha256')
    .update(`${FINGERPRINT_SALT}${chars}${version}`)
    .digest('hex')
    .slice(0, 3)
}

/**
 * Computes the request fingerprint from normalized user/assistant messages.
 */
export function computeFingerprintFromMessages(
  messages: ReadonlyArray<UserMessage | AssistantMessage>,
): string {
  return computeFingerprint(extractFirstMessageText(messages))
}
