/**
 * Pure-TypeScript image magic-byte validation, media type detection, and
 * header dimension parsing (PNG, JPEG, GIF, WebP).
 */

import { API_IMAGE_MAX_BASE64_SIZE } from '../constants/api_limits.js'

export type SupportedImageMediaType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp'

export const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
])

export function isImageExtension(ext: string): boolean {
  return IMAGE_EXTENSIONS.has(ext.toLowerCase())
}

/**
 * Detects image media type from leading magic bytes.
 */
export function detectImageMediaType(
  buffer: Buffer,
): SupportedImageMediaType | null {
  if (buffer.length < 4) return null
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'image/png'
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  // GIF: GIF87a / GIF89a
  if (
    buffer.length >= 6 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) {
    return 'image/gif'
  }
  // WebP: RIFF....WEBP
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp'
  }
  return null
}

/**
 * Extracts pixel width and height from PNG, GIF, JPEG, or WebP headers without
 * external native libraries.
 */
export function parseImageDimensions(
  buffer: Buffer,
): { width: number; height: number } | null {
  const mediaType = detectImageMediaType(buffer)
  if (!mediaType) return null

  if (mediaType === 'image/png' && buffer.length >= 24) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    }
  }

  if (mediaType === 'image/gif' && buffer.length >= 10) {
    return {
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8),
    }
  }

  if (mediaType === 'image/jpeg') {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) break
      const marker = buffer[offset + 1]!
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        }
      }
      const segmentLen = buffer.readUInt16BE(offset + 2)
      if (segmentLen < 2) break
      offset += 2 + segmentLen
    }
  }

  if (mediaType === 'image/webp' && buffer.length >= 30) {
    const chunkType = buffer.toString('ascii', 12, 16)
    if (chunkType === 'VP8X') {
      const width = 1 + buffer.readUIntLE(24, 3)
      const height = 1 + buffer.readUIntLE(27, 3)
      return { width, height }
    }
    if (chunkType === 'VP8 ' && buffer.length >= 30) {
      const width = buffer.readUInt16LE(26) & 0x3fff
      const height = buffer.readUInt16LE(28) & 0x3fff
      return { width, height }
    }
    if (chunkType === 'VP8L' && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21)
      const width = (bits & 0x3fff) + 1
      const height = ((bits >> 14) & 0x3fff) + 1
      return { width, height }
    }
  }

  return null
}

/**
 * Validates that an image buffer is non-empty, has recognized magic bytes, and
 * fits within the API base64 size ceiling.
 */
export function validateImageBuffer(
  buffer: Buffer,
  maxBase64Bytes: number = API_IMAGE_MAX_BASE64_SIZE,
): {
  valid: boolean
  mediaType?: SupportedImageMediaType
  dimensions?: { width: number; height: number }
  error?: string
} {
  if (buffer.length === 0) {
    return { valid: false, error: 'Image file is empty.' }
  }
  const mediaType = detectImageMediaType(buffer)
  if (!mediaType) {
    return {
      valid: false,
      error:
        'Unsupported or corrupted image file (expected PNG, JPEG, GIF, or WebP).',
    }
  }
  const base64Size = Math.ceil((buffer.length * 4) / 3)
  if (base64Size > maxBase64Bytes) {
    return {
      valid: false,
      mediaType,
      error: `Image size (${Math.round(base64Size / 1024)}KB base64) exceeds API limit (${Math.round(maxBase64Bytes / 1024)}KB).`,
    }
  }
  const dimensions = parseImageDimensions(buffer) ?? undefined
  return { valid: true, mediaType, dimensions }
}
