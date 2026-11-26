/**
 * Cryptographic helpers for OAuth 2.0 PKCE (RFC 7636 S256) and CSRF state.
 */

import { createHash, randomBytes } from 'crypto'

/**
 * Encodes a byte buffer using URL-safe Base64 without padding.
 */
export function base64UrlEncode(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

/**
 * Generates a high-entropy 43-character PKCE code verifier.
 */
export function generateCodeVerifier(): string {
  return base64UrlEncode(randomBytes(32))
}

/**
 * Computes the SHA-256 PKCE code challenge (`S256`) for a verifier.
 */
export function generateCodeChallenge(verifier: string): string {
  const digest = createHash('sha256').update(verifier).digest()
  return base64UrlEncode(digest)
}

/**
 * Generates a cryptographically random OAuth CSRF `state` token.
 */
export function generateState(): string {
  return base64UrlEncode(randomBytes(32))
}
