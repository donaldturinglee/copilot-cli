/**
 * Image token-budget resizing/downsampling helper with optional native image
 * processor acceleration and safe pure-TS fallback.
 */

import { API_IMAGE_MAX_BASE64_SIZE } from '../constants/api_limits.js'
import { getImageProcessor } from '../tools/file_read_tool/image_processor.js'
import type { ImageDimensions } from '../types/forward.js'
import {
  detectImageMediaType,
  parseImageDimensions,
  type SupportedImageMediaType,
} from './image_validation.js'

export const MAX_IMAGE_WIDTH = 2000
export const MAX_IMAGE_HEIGHT = 2000
export const MAX_IMAGE_BYTES = Math.floor((API_IMAGE_MAX_BASE64_SIZE * 3) / 4)

export interface ResizedImageResult {
  base64: string
  mediaType: SupportedImageMediaType
  originalSize: number
  dimensions?: ImageDimensions
}

/**
 * Formats an informational metadata caption when an image has been downscaled
 * so coordinates can be mapped back to original pixel dimensions.
 */
export function createImageMetadataText(
  dimensions: ImageDimensions | undefined,
): string | null {
  if (
    !dimensions?.originalWidth ||
    !dimensions?.originalHeight ||
    !dimensions?.displayWidth ||
    !dimensions?.displayHeight
  ) {
    return null
  }
  if (
    dimensions.originalWidth === dimensions.displayWidth &&
    dimensions.originalHeight === dimensions.displayHeight
  ) {
    return null
  }
  return `[Image resized from ${dimensions.originalWidth}x${dimensions.originalHeight} to ${dimensions.displayWidth}x${dimensions.displayHeight}]`
}

/**
 * Resizes an image buffer when a native processor is available and dimensions
 * or size exceed model limits; otherwise validates and encodes as base64.
 */
export async function maybeResizeAndDownsampleImageBuffer(
  buffer: Buffer,
  fallbackMediaType?: SupportedImageMediaType,
  options?: {
    maxWidth?: number
    maxHeight?: number
    maxBytes?: number
  },
): Promise<ResizedImageResult> {
  const maxWidth = options?.maxWidth ?? MAX_IMAGE_WIDTH
  const maxHeight = options?.maxHeight ?? MAX_IMAGE_HEIGHT
  const maxBytes = options?.maxBytes ?? MAX_IMAGE_BYTES

  const mediaType =
    detectImageMediaType(buffer) ?? fallbackMediaType ?? 'image/png'
  const origDims = parseImageDimensions(buffer)

  const needsResize =
    buffer.length > maxBytes ||
    (origDims !== null &&
      (origDims.width > maxWidth || origDims.height > maxHeight))

  if (needsResize) {
    const processor = getImageProcessor()
    if (processor) {
      const resized = await processor.resize(buffer, {
        maxWidth,
        maxHeight,
        quality: 80,
      })
      const resizedMediaType: SupportedImageMediaType =
        resized.format === 'jpeg'
          ? 'image/jpeg'
          : resized.format === 'webp'
            ? 'image/webp'
            : resized.format === 'gif'
              ? 'image/gif'
              : 'image/png'
      return {
        base64: resized.buffer.toString('base64'),
        mediaType: resizedMediaType,
        originalSize: buffer.length,
        dimensions: {
          originalWidth: origDims?.width,
          originalHeight: origDims?.height,
          displayWidth: resized.width,
          displayHeight: resized.height,
        },
      }
    }
  }

  return {
    base64: buffer.toString('base64'),
    mediaType,
    originalSize: buffer.length,
    ...(origDims
      ? {
          dimensions: {
            originalWidth: origDims.width,
            originalHeight: origDims.height,
            displayWidth: origDims.width,
            displayHeight: origDims.height,
          },
        }
      : {}),
  }
}
